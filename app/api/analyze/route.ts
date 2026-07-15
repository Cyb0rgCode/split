import { NextRequest, NextResponse } from "next/server";
import type { AnalyzeRequest, Finding } from "@/lib/types";

export const maxDuration = 30;

const SYSTEM_PROMPT = `You are "Split", a strictly neutral real-time debate referee. You receive the newest slice of a live spoken debate transcript (plus earlier context). Speech-to-text is messy — no punctuation, wrong homophones, filler — read through the noise.

Flag two things in the NEW text:

1. FACT CHECKS — evaluate EVERY concrete, checkable factual claim (statistics, dates, events, laws, science, history, geography).
   - verdict "false": contradicts well-established knowledge, or a statistic far from the accepted figure. "misleading": technically true but framed to deceive. "unverifiable": a specific suspicious statistic that cannot be confirmed.
   - Popular myths are FALSE no matter how many people repeat them, e.g.: Great Wall visible from space/the Moon; humans use 10% of their brains; goldfish 3-second memory; Einstein failed math; Napoleon unusually short; sugar makes children hyperactive; lightning never strikes twice; most body heat lost through the head; bulls enraged by red; swallowing spiders in sleep. Anything of this genre is a flag.
   - Do NOT flag: opinions, predictions, value judgments, anecdotes, obvious hyperbole, or approximately-correct claims (rounding is fine).
   - "correction": the correct fact, one or two sentences. "source_name"/"source_url": a real, well-known authoritative organization (WHO, BLS, NASA, FBI, ...) and its canonical URL — never invented. "search_query": 3-8 words to verify the correction via web search.

2. FALLACIES — only clear-cut cases: ad hominem, straw man, false dilemma, slippery slope, whataboutism, appeal to fear, hasty generalization, red herring, circular reasoning, appeal to authority, tu quoque. Name it and explain in one short sentence. Passionate disagreement is not a fallacy.

Method — think first. Fill the JSON fields in this exact order:
1. "analysis": scratchpad, never shown to the debaters. One terse sentence per factual claim in the NEW text ending in TRUE, FALSE, MISLEADING, or OPINION with the reason; note any fallacy too.
2. "claims_checked": how many claims the analysis covered, including TRUE ones.
3. "findings": an entry for EVERY claim marked FALSE or MISLEADING, plus each fallacy. A FALSE in the analysis with no matching finding is a contradiction and always wrong.

Calibration: a clean slice produces zero findings — do not invent problems. Only flag the NEW text, but re-flag a false claim if the NEW text repeats it. Do not be timid: confidently wrong claims are exactly what you exist to catch. Quotes are short verbatim excerpts from the NEW text.

Examples:

NEW text: "crime is at an all-time high right now and you know it"
{"analysis": "Claim: crime at an all-time high — FALSE, US violent crime is near multi-decade lows.", "claims_checked": 1, "findings": [{"type": "fact_check", "quote": "crime is at an all-time high", "verdict": "false", "correction": "U.S. violent crime has fallen sharply since the early 1990s and is near multi-decade lows, not at an all-time high.", "source_name": "FBI Crime Data Explorer", "source_url": "https://cde.ucr.cjis.gov", "search_query": "US violent crime rate trend FBI"}]}

NEW text: "well I just think raising taxes is a terrible idea and it always backfires"
{"analysis": "Raising taxes is terrible — OPINION. It always backfires — vague prediction, not a checkable claim.", "claims_checked": 0, "findings": []}

NEW text: "of course you'd defend him you work for him so your opinion doesn't count"
{"analysis": "No factual claims. Dismissing the opinion because of who employs him — ad hominem.", "claims_checked": 0, "findings": [{"type": "fallacy", "fallacy_name": "ad hominem", "quote": "you work for him so your opinion doesn't count", "explanation": "It dismisses the argument by attacking the speaker's circumstances instead of the argument itself."}]}

Respond with JSON only, matching this schema:
{"analysis": string, "claims_checked": number, "findings": [
  {"type": "fact_check", "quote": string, "verdict": "false"|"misleading"|"unverifiable", "correction": string, "source_name": string, "source_url": string, "search_query": string},
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
  // analysis first: the model must reason claim-by-claim before it commits
  // to findings, which is what makes small models actually catch myths.
  propertyOrdering: ["analysis", "claims_checked", "findings"],
  properties: {
    analysis: { type: "STRING" },
    claims_checked: { type: "INTEGER" },
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
          search_query: { type: "STRING" },
          fallacy_name: { type: "STRING" },
          explanation: { type: "STRING" },
        },
        required: ["type", "quote"],
      },
    },
  },
  required: ["analysis", "claims_checked", "findings"],
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

async function callGemini(
  chunk: string,
  context?: string,
  extra?: string
): Promise<ModelReply> {
  const key = process.env.GEMINI_API_KEY!;
  const all = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL, ...GEMINI_MODELS]
    : GEMINI_MODELS;
  // Rescue calls get one quick attempt so two rounds fit in the function limit.
  const models = extra ? all.slice(0, 1) : all;

  let lastError = "";
  let lastStatus = 502;
  const deadline = Date.now() + (extra ? 10000 : 18000);
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
              {
                role: "user",
                parts: [
                  {
                    text:
                      buildUserPrompt(chunk, context) +
                      (extra ? `\n\nIMPORTANT: ${extra}` : ""),
                  },
                ],
              },
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

async function callNvidiaNim(
  chunk: string,
  context?: string,
  extra?: string
): Promise<ModelReply> {
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
          {
            role: "user",
            content:
              buildUserPrompt(chunk, context) +
              (extra ? `\n\nIMPORTANT: ${extra}` : ""),
          },
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

/** Pull a JSON object out of a model reply that may include prose or fences. */
function extractJson(
  text: string
): { findings?: unknown; claims_checked?: unknown; analysis?: unknown } | null {
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
    const type = typeof f.type === "string" ? f.type.toLowerCase().replace(/-/g, "_") : "";
    if (type === "fact_check") {
      // Models sometimes capitalize despite the schema — don't drop findings over it.
      const verdict =
        typeof f.verdict === "string" ? f.verdict.toLowerCase().trim() : "";
      if (verdict !== "false" && verdict !== "misleading" && verdict !== "unverifiable") continue;
      // Lazy responses sometimes put the substance in "explanation" — don't
      // silently drop a real finding over a missing field name.
      const correction =
        typeof f.correction === "string" && f.correction.trim()
          ? f.correction.trim()
          : typeof f.explanation === "string"
            ? f.explanation.trim()
            : "";
      if (!correction) continue;
      findings.push({
        type: "fact_check",
        quote,
        verdict,
        correction,
        source_name: typeof f.source_name === "string" ? f.source_name.trim() : "",
        source_url:
          typeof f.source_url === "string" && /^https?:\/\//.test(f.source_url.trim())
            ? f.source_url.trim()
            : "",
        search_query:
          typeof f.search_query === "string" ? f.search_query.trim() : undefined,
      });
    } else if (type === "fallacy") {
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

  // Honor the provider the user picked in the UI; fall back sensibly.
  const requested = (body as { provider?: string }).provider;
  let useGemini = hasGemini;
  if (requested === "nvidia") {
    if (!hasNim) {
      return NextResponse.json(
        { error: "NVIDIA NIM not configured — set NVIDIA_NIM_API_KEY." },
        { status: 503 }
      );
    }
    useGemini = false;
  } else if (requested === "gemini" && !hasGemini) {
    return NextResponse.json(
      { error: "Gemini not configured — set GEMINI_API_KEY." },
      { status: 503 }
    );
  }

  try {
    const result = await runAnalysis(useGemini, chunk, context);
    return NextResponse.json({
      findings: result.findings,
      claims_checked: result.claimsChecked,
      provider: useGemini ? "gemini" : "nvidia-nim",
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

interface AnalysisResult {
  findings: Finding[];
  claimsChecked: number;
  analysis: string;
  model: string;
  rescued: boolean;
}

async function runAnalysis(
  useGemini: boolean,
  chunk: string,
  context?: string
): Promise<AnalysisResult> {
  const first = useGemini
    ? await callGemini(chunk, context)
    : await callNvidiaNim(chunk, context);
  let parsed = extractJson(first.text);
  let findings = sanitizeFindings(parsed?.findings);
  const analysis =
    typeof parsed?.analysis === "string" ? parsed.analysis.slice(0, 800) : "";
  // Visible in Vercel function logs — the model's claim-by-claim reasoning.
  if (analysis) console.log(`analysis (${first.model}):`, analysis.slice(0, 500));

  // Contradiction rescue: the scratchpad says FALSE/MISLEADING but findings
  // came back empty — the exact lazy-model failure that shows the debaters a
  // wrong "all accurate". One follow-up call forces the conversion.
  let rescued = false;
  if (findings.length === 0 && /\b(FALSE|MISLEADING)\b/.test(analysis)) {
    console.warn("contradiction: analysis flagged claims but findings empty — rescuing");
    try {
      const extra = `Your previous analysis of this exact text was: "${analysis}". It marked at least one claim FALSE or MISLEADING, yet you returned zero findings — a contradiction. Respond again with the same JSON schema, converting EVERY claim that analysis marked FALSE or MISLEADING into a findings entry with verdict, correction, source_name, source_url and search_query.`;
      const second = useGemini
        ? await callGemini(chunk, context, extra)
        : await callNvidiaNim(chunk, context, extra);
      const parsed2 = extractJson(second.text);
      const findings2 = sanitizeFindings(parsed2?.findings);
      if (findings2.length > 0) {
        findings = findings2;
        parsed = parsed2 ?? parsed;
        rescued = true;
      }
    } catch (err) {
      console.error("rescue pass failed:", err); // keep the first result
    }
  }

  const claimsChecked =
    typeof parsed?.claims_checked === "number" && parsed.claims_checked >= 0
      ? Math.round(parsed.claims_checked)
      : findings.filter((f) => f.type === "fact_check").length;
  return { findings, claimsChecked, analysis, model: first.model, rescued };
}

/**
 * Self-test: open /api/analyze in a browser. Runs a blatantly false claim
 * through the full pipeline and reports the model used, its claim-by-claim
 * analysis, and whether the claim was flagged. Uses 1-2 quota requests.
 */
export async function GET() {
  const chunk = "The sun revolves around the Earth, everyone knows that.";
  const hasGemini = !!process.env.GEMINI_API_KEY;
  const hasNim = !!process.env.NVIDIA_NIM_API_KEY;
  if (!hasGemini && !hasNim) {
    return NextResponse.json(
      { error: "No AI provider configured — set GEMINI_API_KEY." },
      { status: 503 }
    );
  }
  try {
    const result = await runAnalysis(hasGemini, chunk);
    return NextResponse.json({
      verdict:
        result.findings.length > 0
          ? "PASS — the false claim was flagged"
          : "FAIL — the false claim was NOT flagged (share this JSON when reporting)",
      test_input: chunk,
      model: result.model,
      provider: hasGemini ? "gemini" : "nvidia-nim",
      rescued: result.rescued,
      claims_checked: result.claimsChecked,
      findings: result.findings,
      analysis: result.analysis,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 400) : "failed" },
      { status: 502 }
    );
  }
}
