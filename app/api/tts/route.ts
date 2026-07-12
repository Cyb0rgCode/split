import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/* Tried in order. Each Gemini TTS model has its own free-tier quota
   (~10 requests/day), so falling through on 429 buys extra callouts. */
const TTS_MODELS = [
  "gemini-3.1-flash-tts",
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-tts",
  "gemini-2.5-flash-preview-tts",
];

/** Gemini TTS returns raw 16-bit mono PCM; browsers need a WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface TtsAttempt {
  provider: string;
  status: number;
  error?: string;
}

/** ElevenLabs TTS — free plan: 10,000 credits/month, ~0.5 credit per
    character on the flash model. Returns MP3 directly. Tries the cheap
    flash model first, then eleven_v3 for accounts without it. */
async function elevenLabsTts(
  text: string,
  attempts: TtsAttempt[],
  voiceOverride?: string
): Promise<ArrayBuffer | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voiceId =
    voiceOverride || process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // George
  const models = [
    ...new Set([process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5", "eleven_v3"]),
  ];
  for (const modelId of models) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": key,
          },
          body: JSON.stringify({ text, model_id: modelId }),
          signal: AbortSignal.timeout(12000),
        }
      );
      if (res.ok) return await res.arrayBuffer();
      attempts.push({
        provider: `elevenlabs:${modelId}`,
        status: res.status,
        error: (await res.text()).slice(0, 300),
      });
      if (res.status === 401 || res.status === 403) break; // bad key — stop
    } catch (err) {
      attempts.push({
        provider: `elevenlabs:${modelId}`,
        status: 0,
        error: String(err).slice(0, 300),
      });
    }
  }
  return null; // fall through to Gemini TTS
}

async function geminiTtsModel(
  model: string,
  text: string,
  attempts: TtsAttempt[],
  voiceOverride?: string
): Promise<Buffer | null> {
  const key = process.env.GEMINI_API_KEY!;
  const voice = voiceOverride || process.env.GEMINI_TTS_VOICE || "Kore";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Say this in a confident, assertive debate-referee voice: ${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) {
      attempts.push({
        provider: `gemini:${model}`,
        status: res.status,
        error: (await res.text()).slice(0, 300),
      });
      return null;
    }
    const data = await res.json();
    const part = data?.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => p?.inlineData?.data
    );
    if (!part) {
      attempts.push({
        provider: `gemini:${model}`,
        status: 200,
        error: "response had no audio part",
      });
      return null;
    }
    const rate =
      Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24000;
    return pcmToWav(Buffer.from(part.inlineData.data, "base64"), rate);
  } catch (err) {
    attempts.push({
      provider: `gemini:${model}`,
      status: 0,
      error: String(err).slice(0, 300),
    });
    return null;
  }
}

function geminiModelList(): string[] {
  return process.env.GEMINI_TTS_MODEL
    ? [process.env.GEMINI_TTS_MODEL, ...TTS_MODELS]
    : TTS_MODELS;
}

/** True for errors where trying another Gemini model can't help. */
function isFatal(attempt: TtsAttempt): boolean {
  return attempt.status === 401 || attempt.status === 403;
}

export async function POST(req: NextRequest) {
  let text = "";
  let provider = "";
  let voice = "";
  try {
    const body = await req.json();
    text = typeof body.text === "string" ? body.text.trim() : "";
    provider = typeof body.provider === "string" ? body.provider : "";
    voice = typeof body.voice === "string" ? body.voice.trim().slice(0, 60) : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "Missing 'text'" }, { status: 400 });
  if (text.length > 600) {
    return NextResponse.json({ error: "Text too long" }, { status: 413 });
  }

  const attempts: TtsAttempt[] = [];

  // "elevenlabs" / "gemini" pins that provider (the client picked it in the
  // voice menu and falls back to the browser voice itself); empty tries all.
  if (provider !== "gemini") {
    const eleven = await elevenLabsTts(text, attempts, voice || undefined);
    if (eleven) {
      return new NextResponse(eleven, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      });
    }
    if (provider === "elevenlabs") {
      return NextResponse.json(
        { error: "TTS unavailable", attempts },
        { status: attempts[attempts.length - 1]?.status || 503 }
      );
    }
  }

  if (process.env.GEMINI_API_KEY) {
    for (const model of geminiModelList()) {
      const wav = await geminiTtsModel(model, text, attempts, voice || undefined);
      if (wav) {
        return new NextResponse(new Uint8Array(wav), {
          headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
        });
      }
      if (isFatal(attempts[attempts.length - 1])) break;
    }
  } else {
    attempts.push({ provider: "gemini", status: 503, error: "GEMINI_API_KEY not set" });
  }

  console.error("tts failed:", JSON.stringify(attempts));
  // Non-200 tells the client to fall back to browser speech synthesis.
  return NextResponse.json(
    { error: "TTS unavailable", attempts },
    { status: attempts[attempts.length - 1]?.status || 502 }
  );
}

/**
 * Self-test: open /api/tts in a browser to see exactly why (or whether)
 * each TTS provider works. Costs one quota request per attempted model.
 */
export async function GET() {
  const attempts: TtsAttempt[] = [];
  const text = "Test.";
  let working: string | null = null;

  if (process.env.ELEVENLABS_API_KEY) {
    const eleven = await elevenLabsTts(text, attempts);
    if (eleven) {
      working = "elevenlabs";
      attempts.push({ provider: "elevenlabs", status: 200 });
    }
  } else {
    attempts.push({
      provider: "elevenlabs",
      status: 503,
      error: "ELEVENLABS_API_KEY not set (optional)",
    });
  }

  if (!working) {
    if (process.env.GEMINI_API_KEY) {
      for (const model of geminiModelList()) {
        const wav = await geminiTtsModel(model, text, attempts);
        if (wav) {
          working = `gemini:${model}`;
          attempts.push({ provider: `gemini:${model}`, status: 200 });
          break;
        }
        if (isFatal(attempts[attempts.length - 1])) break;
      }
    } else {
      attempts.push({
        provider: "gemini",
        status: 503,
        error: "GEMINI_API_KEY not set",
      });
    }
  }

  return NextResponse.json({
    working_provider: working ?? "none — the app will use the browser voice",
    attempts,
  });
}
