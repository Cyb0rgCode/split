import { NextRequest, NextResponse } from "next/server";
import type { AnalyzeRequest, Finding } from "@/lib/types";

export const maxDuration = 30;

const SYSTEM_PROMPT = `You are "Split", a strictly neutral real-time debate referee. You are listening to a live spoken debate between two people. You receive the newest slice of the transcript (plus earlier context). Speech-to-text output is messy: ignore filler words, self-corrections, and transcription noise.

Your job is to flag ONLY two kinds of things in the NEW text:

1. FACT CHECKS — a specific factual claim or statistic that is false, misleading, or made-up.
   - Only flag checkable, concrete claims (numbers, dates, events, laws, science). Never flag opinions, predictions, values, or hyperbole/figures of speech.
   - Give the correct claim or statistic, stated plainly.
   - Cite a real, well-known authoritative source (e.g. WHO, BLS, US Census Bureau, NASA, peer-reviewed bodies, official statistics agencies) with a plausible canonical URL for that organization (e.g. https://www.who.int, https://www.bls.gov). Never invent an organization.
   - verdict must be "false", "misleading", or "unverifiable". Only use "unverifiable" for suspicious-sounding statistics that cannot be confirmed — and even then, only if flagging it genuinely helps the debate.

2. FALLACIES — a clear logical fallacy or personal attack, e.g. ad hominem, straw man, false dilemma, slippery slope, whataboutism, appeal to fear, hasty generalization, red herring, circular reasoning, appeal to authority, tu quoque.
   - Only flag clear-cut cases. Passionate disagreement is not a fallacy.
   - Name the fallacy and explain in one short sentence why the quoted statement commits it.

Be very conservative: most slices of ordinary conversation contain NOTHING to flag, and an empty findings list is the most common correct answer. False alarms destroy trust in the referee. Do not re-flag anything already covered by the context. Quotes must be short verbatim excerpts from the NEW text.

Respond with JSON only, matching this schema:
{"findings": [
  {"type": "fact_check", "quote": string, "verdict": "false"|"misleading"|"unverifiable", "correction": string, "source_name": string, "source_url": string},
  {"type": "fallacy", "fallacy_name": string, "quote": string, "explanation": string}
]}`;

function buildUserPrompt(chunk: string, context?: string): string {
  const ctx = context?.trim()
    ? `Earlier transcript (context only — do NOT flag anything in it):\n"""${context.trim()}"""\n\n`
    : "";
  return `${ctx}NEW transcript text to analyze:\n"""${chunk.trim()}"""`;
}

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["fact_check", "fallacy"] },
          quote: { type: "STRING" },
          verdict: {
            type: "STRING",
            enum: ["false", "misleading", "unverifiable"],
          },
          correction: { type: "STRING" },
          source_name: { type: "STRING" },
          source_url: { type: "STRING" },
          fallacy_name: { type: "STRING" },
          explanation: { type: "STRING" },
        },
        required: ["type", "quote"],
      },
    },
  },
  required: ["findings"],
};

async function callGemini(chunk: string, context?: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          { role: "user", parts: [{ text: buildUserPrompt(chunk, context) }] },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callNvidiaNim(chunk: string, context?: string): Promise<string> {
  const key = process.env.NVIDIA_NIM_API_KEY!;
  const model = process.env.NVIDIA_NIM_MODEL || "meta/llama-3.3-70b-instruct";
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(chunk, context) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`NVIDIA NIM API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Pull a JSON object out of a model reply that may include prose or fences. */
function extractJson(text: string): { findings?: unknown } | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const findings: Finding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const quote = typeof f.quote === "string" ? f.quote.trim() : "";
    if (!quote) continue;
    if (f.type === "fact_check") {
      const verdict = f.verdict;
      if (verdict !== "false" && verdict !== "misleading" && verdict !== "unverifiable") continue;
      if (typeof f.correction !== "string" || !f.correction.trim()) continue;
      findings.push({
        type: "fact_check",
        quote,
        verdict,
        correction: f.correction.trim(),
        source_name: typeof f.source_name === "string" ? f.source_name.trim() : "",
        source_url:
          typeof f.source_url === "string" && /^https?:\/\//.test(f.source_url.trim())
            ? f.source_url.trim()
            : "",
      });
    } else if (f.type === "fallacy") {
      if (typeof f.fallacy_name !== "string" || !f.fallacy_name.trim()) continue;
      findings.push({
        type: "fallacy",
        fallacy_name: f.fallacy_name.trim(),
        quote,
        explanation: typeof f.explanation === "string" ? f.explanation.trim() : "",
      });
    }
  }
  return findings.slice(0, 6);
}

export async function POST(req: NextRequest) {
  let body: AnalyzeRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const chunk = typeof body.chunk === "string" ? body.chunk.trim() : "";
  const context = typeof body.context === "string" ? body.context : undefined;
  if (!chunk) {
    return NextResponse.json({ error: "Missing 'chunk'" }, { status: 400 });
  }
  if (chunk.length > 4000 || (context?.length ?? 0) > 8000) {
    return NextResponse.json({ error: "Input too long" }, { status: 413 });
  }

  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasNim = !!process.env.NVIDIA_NIM_API_KEY;
  if (!hasGemini && !hasNim) {
    return NextResponse.json(
      {
        error:
          "No AI provider configured. Set GEMINI_API_KEY (https://aistudio.google.com/apikey) or NVIDIA_NIM_API_KEY (https://build.nvidia.com) in your environment.",
      },
      { status: 503 }
    );
  }

  try {
    const raw = hasGemini
      ? await callGemini(chunk, context)
      : await callNvidiaNim(chunk, context);
    const parsed = extractJson(raw);
    const findings = sanitizeFindings(parsed?.findings);
    return NextResponse.json({
      findings,
      provider: hasGemini ? "gemini" : "nvidia-nim",
    });
  } catch (err) {
    console.error("analyze failed:", err);
    return NextResponse.json({ error: "Analysis failed" }, { status: 502 });
  }
}
