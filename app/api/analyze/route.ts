import { NextRequest, NextResponse } from "next/server";
import type { AnalyzeRequest, Finding, Verdict } from "@/lib/types";

export const maxDuration = 30;

/* The output contract is verdict-per-claim: the model must judge EVERY
   claim it extracts, and the server converts every non-"true" verdict into
   an alert. This kills the lazy failure mode where a model "checked" claims
   but emitted an empty findings list, which showed a wrong "all accurate". */
const SYSTEM_PROMPT = `You are "Split", a strictly neutral real-time debate referee. You receive the newest slice of a live spoken debate transcript (plus earlier context). Speech-to-text is messy — no punctuation, wrong homophones, filler — read through the noise.

Respond with JSON only: {"claims": [...], "fallacies": [...]}

CLAIMS — extract EVERY concrete, checkable factual claim in the NEW text (statistics, dates, events, laws, science, health, history, geography) and give each one a verdict:
- "true": consistent with well-established knowledge. Approximately correct counts as true — reasonable rounding is fine.
- "false": contradicts well-established knowledge, or a statistic far from the accepted figure. Popular myths are always false no matter how many people repeat them: the Great Wall visible from space or the Moon, humans use 10% of their brains, goldfish 3-second memory, Einstein failed math, Napoleon unusually short, sugar makes children hyperactive, lightning never strikes twice, most body heat lost through the head, bulls enraged by the color red, the sun orbits the Earth — and anything of that genre.
- "misleading": technically true but framed to deceive.
- "unverifiable": a specific suspicious statistic that cannot be confirmed.
Do NOT list opinions, predictions, value judgments, personal anecdotes, or obvious hyperbole as claims.
For every claim whose verdict is NOT "true", also provide: "correction" — the correct fact in one or two sentences; "source_name" and "source_url" — a real, well-known authoritative organization (WHO, BLS, NASA, FBI, Britannica, ...) and its canonical URL, never invented; "search_query" — 3-8 words to verify the correction via web search.
"quote" is always a short verbatim excerpt from the NEW text. Only evaluate the NEW text; if it repeats a false claim from the context, flag it again.

FALLACIES — only clear-cut cases: ad hominem, straw man, false dilemma, slippery slope, whataboutism, appeal to fear, hasty generalization, red herring, circular reasoning, appeal to authority, tu quoque. Passionate disagreement is not a fallacy. Each entry: "fallacy_name", "quote" (verbatim), "explanation" (one short sentence).

Examples:

NEW text: "crime is at an all-time high right now and you know it"
{"claims": [{"quote": "crime is at an all-time high", "verdict": "false", "correction": "U.S. violent crime has fallen sharply since the early 1990s and is near multi-decade lows, not at an all-time high.", "source_name": "FBI Crime Data Explorer", "source_url": "https://cde.ucr.cjis.gov", "search_query": "US violent crime rate trend FBI"}], "fallacies": []}

NEW text: "water boils at 100 degrees celsius at sea level"
{"claims": [{"quote": "water boils at 100 degrees celsius at sea level", "verdict": "true"}], "fallacies": []}

NEW text: "well I just think raising taxes is a terrible idea and it always backfires"
{"claims": [], "fallacies": []}

NEW text: "of course you'd defend him you work for him so your opinion doesn't count"
{"claims": [], "fallacies": [{"fallacy_name": "ad hominem", "quote": "you work for him so your opinion doesn't count", "explanation": "It dismisses the argument by attacking the speaker's circumstances instead of the argument itself."}]}`;

function buildUserPrompt(chunk: string, context?: string): string {
  const ctx = context?.trim()
    ? `Earlier transcript (context only — do NOT evaluate it):\n"""${context.trim()}"""\n\n`
    : "";
  return `${ctx}NEW transcript text to analyze:\n"""${chunk.trim()}"""`;
}

const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  propertyOrdering: ["claims", "fallacies"],
  properties: {
    claims: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        propertyOrdering: [
          "quote",
          "verdict",
          "correction",
          "source_name",
          "source_url",
          "search_query",
        ],
        properties: {
          quote: { type: "STRING" },
          verdict: {
            type: "STRING",
            enum: ["true", "false", "misleading", "unverifiable"],
          },
          correction: { type: "STRING" },
          source_name: { type: "STRING" },
          source_url: { type: "STRING" },
          search_query: { type: "STRING" },
        },
        required: ["quote", "verdict"],
      },
    },
    fallacies: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          fallacy_name: { type: "STRING" },
          quote: { type: "STRING" },
          explanation: { type: "STRING" },
        },
        required: ["fallacy_name", "quote"],
      },
    },
  },
  required: ["claims", "fallacies"],
};

/* Tried in order; a 404 (model renamed/retired) falls through to the next. */
const GEMINI_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

interface ModelReply {
  text: string;
  model: string;
}

async function callGemini(chunk: string, context?: string): Promise<ModelReply> {
  const key = process.env.GEMINI_API_KEY!;
  const models = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL, ...GEMINI_MODELS]
    : GEMINI_MODELS;

  let lastError = "";
  let lastStatus = 502;
  const deadline = Date.now() + 18000; // stay well under the platform timeout
  for (const model of models) {
    const budget = deadline - Date.now();
    if (budget < 2000) break;
    let res: Response;
    try {
      res = await fetch(
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
          signal: AbortSignal.timeout(Math.min(12000, budget)),
        }
      );
    } catch (err) {
      // Slow generation — report as transient so the client retries quietly.
      lastStatus = 503;
      lastError = `Gemini timed out on ${model}: ${String(err).slice(0, 120)}`;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      return {
        text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
        model,
      };
    }
    lastStatus = res.status;
    lastError = `Gemini API error ${res.status} on ${model}: ${await res.text()}`;
    // Auth errors can't be fixed by another model; anything else (404 gone,
    // 429 quota — each model has its own, 500/503 hiccups) falls through.
    if (res.status === 401 || res.status === 403) break;
  }
  throw Object.assign(new Error(lastError), { status: lastStatus });
}

async function callNvidiaNim(chunk: string, context?: string): Promise<ModelReply> {
  const key = process.env.NVIDIA_NIM_API_KEY!;
  const model = process.env.NVIDIA_NIM_MODEL || "minimaxai/minimax-m3";
  let res: Response;
  try {
    res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        // Reasoning models (MiniMax M3) burn tokens thinking before the JSON
        // answer — leave generous room so the answer isn't truncated.
        max_tokens: 4096,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(chunk, context) },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw Object.assign(
      new Error(`NVIDIA NIM timed out: ${String(err).slice(0, 120)}`),
      { status: 503 }
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`NVIDIA NIM API error ${res.status}: ${await res.text()}`),
      { status: res.status }
    );
  }
  const data = await res.json();
  return { text: data?.choices?.[0]?.message?.content ?? "", model };
}

interface ParsedReply {
  claims?: unknown;
  fallacies?: unknown;
}

/** Pull a JSON object out of a model reply that may include prose or fences. */
function extractJson(text: string): ParsedReply | null {
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

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Convert verdict-per-claim output into findings mechanically. */
function toFindings(parsed: ParsedReply | null): {
  findings: Finding[];
  claimsChecked: number;
} {
  const findings: Finding[] = [];
  let claimsChecked = 0;

  if (parsed && Array.isArray(parsed.claims)) {
    for (const item of parsed.claims) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const quote = str(c.quote);
      const verdict = str(c.verdict).toLowerCase();
      if (!quote || !verdict) continue;
      claimsChecked++;
      if (verdict !== "false" && verdict !== "misleading" && verdict !== "unverifiable") {
        continue; // "true" (or anything unrecognized) is not an alert
      }
      findings.push({
        type: "fact_check",
        quote,
        verdict: verdict as Verdict,
        correction:
          str(c.correction) || "This claim contradicts well-established facts.",
        source_name: str(c.source_name),
        source_url: /^https?:\/\//.test(str(c.source_url)) ? str(c.source_url) : "",
        search_query: str(c.search_query) || undefined,
      });
    }
  }

  if (parsed && Array.isArray(parsed.fallacies)) {
    for (const item of parsed.fallacies) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const quote = str(f.quote);
      const name = str(f.fallacy_name);
      if (!quote || !name) continue;
      findings.push({
        type: "fallacy",
        fallacy_name: name,
        quote,
        explanation: str(f.explanation),
      });
    }
  }

  return { findings: findings.slice(0, 8), claimsChecked };
}

async function runAnalysis(useGemini: boolean, chunk: string, context?: string) {
  const reply = useGemini
    ? await callGemini(chunk, context)
    : await callNvidiaNim(chunk, context);
  const parsed = extractJson(reply.text);
  const { findings, claimsChecked } = toFindings(parsed);
  console.log(
    `analyze (${reply.model}): ${claimsChecked} claims, ${findings.length} findings`
  );
  return { findings, claimsChecked, model: reply.model, parsed };
}

function pickProvider(requested?: string): { useGemini: boolean } | NextResponse {
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
  if (requested === "nvidia") {
    if (!hasNim) {
      return NextResponse.json(
        { error: "NVIDIA NIM not configured — set NVIDIA_NIM_API_KEY." },
        { status: 503 }
      );
    }
    return { useGemini: false };
  }
  if (requested === "gemini" && !hasGemini) {
    return NextResponse.json(
      { error: "Gemini not configured — set GEMINI_API_KEY." },
      { status: 503 }
    );
  }
  return { useGemini: hasGemini };
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

  const picked = pickProvider(body.provider);
  if (picked instanceof NextResponse) return picked;

  try {
    const result = await runAnalysis(picked.useGemini, chunk, context);
    return NextResponse.json({
      findings: result.findings,
      claims_checked: result.claimsChecked,
      provider: picked.useGemini ? "gemini" : "nvidia-nim",
      model: result.model,
    });
  } catch (err) {
    console.error("analyze failed:", err);
    const detail = err instanceof Error ? err.message.slice(0, 300) : "";
    const upstream = (err as { status?: number }).status;
    // Pass rate limits / overload through so the client backs off quietly.
    const status = upstream === 429 || upstream === 503 ? upstream : 502;
    return NextResponse.json(
      { error: `Analysis failed. ${detail}`.trim() },
      { status }
    );
  }
}

/**
 * Self-test: open /api/analyze in a browser — add ?provider=nvidia to test
 * NIM, or ?q=your+own+claim. Runs the full pipeline with your real keys and
 * reports the model, the raw per-claim verdicts, and PASS/FAIL.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  const chunk = q?.trim() || "The sun revolves around the Earth, everyone knows that.";
  const requested = req.nextUrl.searchParams.get("provider") ?? undefined;

  const picked = pickProvider(requested);
  if (picked instanceof NextResponse) return picked;

  try {
    const result = await runAnalysis(picked.useGemini, chunk);
    return NextResponse.json({
      verdict:
        result.findings.length > 0
          ? "PASS — the claim was flagged"
          : "FAIL — nothing flagged (share this JSON when reporting)",
      test_input: chunk,
      provider: picked.useGemini ? "gemini" : "nvidia-nim",
      model: result.model,
      claims_checked: result.claimsChecked,
      findings: result.findings,
      raw_claims: (result.parsed as ParsedReply | null)?.claims ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 400) : "failed" },
      { status: 502 }
    );
  }
}
