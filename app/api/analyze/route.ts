import { NextRequest, NextResponse } from "next/server";
import type { AnalyzeRequest, Finding } from "@/lib/types";
import { pickBestResult, searchWeb } from "@/lib/search";

export const maxDuration = 30;

const SYSTEM_PROMPT = `You are "Split", a strictly neutral real-time debate referee listening to a live spoken debate between two people. You receive the newest slice of the transcript (plus earlier context). Speech-to-text output is messy — no punctuation, wrong homophones, filler words — so read through the noise.

Work through the NEW text claim by claim:

1. FACT CHECKS — evaluate EVERY concrete, checkable factual claim (statistics, numbers, dates, events, laws, science, history, geography) against well-established knowledge.
   - Flag any claim that is false or significantly misleading. A statistic far from the accepted figure is "false"; a technically-true claim framed to deceive is "misleading". Use "unverifiable" for specific suspicious statistics that cannot be confirmed.
   - Popular myths count as FALSE even though millions of people repeat them. Canonical examples you must always flag: "the Great Wall of China is visible from space/the Moon", "humans only use 10% of their brains", "goldfish have a 3-second memory", "Einstein failed math", "Napoleon was unusually short", "sugar makes children hyperactive", "lightning never strikes the same place twice", "you lose most of your body heat through your head", "bulls are enraged by the color red", "we swallow spiders in our sleep". Anything of this genre — a widely repeated factoid contradicted by science or history — is a flag.
   - Do NOT flag: opinions, predictions, moral or value judgments, personal anecdotes, obvious hyperbole ("a million times"), or claims that are approximately correct (reasonable rounding is fine).
   - "correction" states the correct fact or figure plainly, in one or two sentences.
   - Cite a real, well-known authoritative source (e.g. WHO, BLS, US Census Bureau, NASA, FBI, peer-reviewed bodies, official statistics agencies) with a plausible canonical URL for that organization. Never invent an organization.
   - Provide a short "search_query" (3-8 words) that a web search could use to verify the correct figure — the app runs this search to attach a live source.

2. FALLACIES — a clear logical fallacy or personal attack, e.g. ad hominem, straw man, false dilemma, slippery slope, whataboutism, appeal to fear, hasty generalization, red herring, circular reasoning, appeal to authority, tu quoque.
   - Only flag clear-cut cases. Passionate disagreement is not a fallacy.
   - Name the fallacy and explain in one short sentence why the quoted statement commits it.

Calibration: do not invent problems — a clean slice of argument produces zero findings. Only flag what appears in the NEW text, but if the NEW text repeats a false claim that was already made earlier in the context, flag it again anyway. And do not be timid: a wrong claim stated with confidence is exactly what you exist to catch, and letting it slide defeats your purpose. When you are sure a claim is wrong, flag it. Quotes must be short verbatim excerpts from the NEW text.

Method — think before you answer. Fill the JSON fields in this exact order:
1. "analysis": your scratchpad. Go claim by claim through the NEW text; for each factual claim write one terse sentence ending in a verdict word: TRUE, FALSE, MISLEADING, or OPINION, with the reason. Note any fallacy here too. Be brutally honest — this field is never shown to the debaters.
2. "claims_checked": how many factual claims your analysis covered, including the TRUE ones.
3. "findings": one entry for EVERY claim your analysis marked FALSE or MISLEADING, plus each clear fallacy. If your analysis says FALSE, that claim MUST appear in findings — a FALSE in the analysis with an empty findings list is a contradiction and always wrong.

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

async function callGemini(chunk: string, context?: string): Promise<string> {
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
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }
    lastStatus = res.status;
    lastError = `Gemini API error ${res.status} on ${model}: ${await res.text()}`;
    // Auth errors can't be fixed by another model; anything else (404 gone,
    // 429 quota — each model has its own, 500/503 hiccups) falls through.
    if (res.status === 401 || res.status === 403) break;
  }
  throw Object.assign(new Error(lastError), { status: lastStatus });
}

async function callNvidiaNim(chunk: string, context?: string): Promise<string> {
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
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Pull a JSON object out of a model reply that may include prose or fences. */
function extractJson(
  text: string
): { findings?: unknown; claims_checked?: unknown } | null {
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

/**
 * Replace each fact-check's model-remembered source with a live web search
 * result. Best-effort: on search failure the model's citation is kept, and
 * the internal search_query is dropped from the response either way.
 */
async function attachLiveSources(findings: Finding[]): Promise<void> {
  const enrich = Promise.all(
    findings.map(async (f) => {
      if (f.type !== "fact_check") return;
      const query = f.search_query || f.correction;
      delete f.search_query;
      const results = await searchWeb(query.slice(0, 200));
      if (!results) return;
      const best = pickBestResult(results);
      f.source_name = best.title.slice(0, 120);
      f.source_url = best.url;
    })
  );
  // Never let a slow search delay the callout — after 5s ship the model's
  // own citation instead.
  await Promise.race([enrich, new Promise((r) => setTimeout(r, 5000))]);
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
    const raw = useGemini
      ? await callGemini(chunk, context)
      : await callNvidiaNim(chunk, context);
    const parsed = extractJson(raw);
    const findings = sanitizeFindings(parsed?.findings);
    // Visible in Vercel function logs — the model's claim-by-claim reasoning.
    if (typeof (parsed as { analysis?: unknown })?.analysis === "string") {
      console.log("analysis:", (parsed as { analysis: string }).analysis.slice(0, 500));
    }
    if (body.search !== false) {
      await attachLiveSources(findings);
    } else {
      // Search disabled in the UI — keep the model's citation, just drop
      // the internal search_query field.
      for (const f of findings) {
        if (f.type === "fact_check") delete f.search_query;
      }
    }
    const claimsChecked =
      typeof parsed?.claims_checked === "number" && parsed.claims_checked >= 0
        ? Math.round(parsed.claims_checked)
        : findings.filter((f) => f.type === "fact_check").length;
    return NextResponse.json({
      findings,
      claims_checked: claimsChecked,
      provider: useGemini ? "gemini" : "nvidia-nim",
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
