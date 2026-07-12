import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

/* Tried in order; a 404 (renamed/retired preview) falls through to the next. */
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

/** Grok TTS (paid, ~$4.20/M chars) — returns MP3 directly. */
async function grokTts(text: string): Promise<NextResponse | null> {
  const key = process.env.XAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        text,
        voice_id: process.env.XAI_TTS_VOICE || "eve",
        language: "en",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error("grok tts failed:", res.status, (await res.text()).slice(0, 300));
      return null; // fall through to Gemini TTS
    }
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("grok tts failed:", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = await req.json();
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "Missing 'text'" }, { status: 400 });
  if (text.length > 600) {
    return NextResponse.json({ error: "Text too long" }, { status: 413 });
  }

  const grok = await grokTts(text);
  if (grok) return grok;

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "No TTS provider configured" }, { status: 503 });
  }

  const voice = process.env.GEMINI_TTS_VOICE || "Kore";
  const models = process.env.GEMINI_TTS_MODEL
    ? [process.env.GEMINI_TTS_MODEL, ...TTS_MODELS]
    : TTS_MODELS;

  let lastStatus = 502;
  let lastError = "";
  for (const model of models) {
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
      }
    );
    if (res.ok) {
      const data = await res.json();
      const part = data?.candidates?.[0]?.content?.parts?.find(
        (p: { inlineData?: { data?: string } }) => p?.inlineData?.data
      );
      if (!part) {
        return NextResponse.json({ error: "No audio in response" }, { status: 502 });
      }
      const rate =
        Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24000;
      const wav = pcmToWav(Buffer.from(part.inlineData.data, "base64"), rate);
      return new NextResponse(new Uint8Array(wav), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
      });
    }
    lastStatus = res.status;
    lastError = await res.text();
    if (res.status !== 404) break; // quota (429) / auth errors — don't mask
  }
  console.error("tts failed:", lastStatus, lastError.slice(0, 300));
  // Non-200 tells the client to fall back to browser speech synthesis.
  return NextResponse.json({ error: "TTS unavailable" }, { status: lastStatus });
}
