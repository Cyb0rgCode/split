"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeech } from "@/lib/useSpeech";
import WaveBar from "@/components/WaveBar";
import type { AnalyzeResponse, Finding } from "@/lib/types";

interface PlacedFinding {
  id: number;
  finding: Finding;
  /** Transcript length when the finding arrived — anchors it inline. */
  offset: number;
}

const ANALYZE_INTERVAL_MS = 4000;
const MIN_CHUNK_CHARS = 40;
const MAX_WAIT_MS = 10000;
const CONTEXT_CHARS = 1500;

const VERDICT_LABEL: Record<string, string> = {
  false: "Liar alert",
  misleading: "Misleading",
  unverifiable: "Unverifiable",
};

function normalizeQuote(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** What the referee says out loud when it cuts in. */
function ttsText(f: Finding): string {
  if (f.type === "fallacy") {
    const article = /^[aeiou]/i.test(f.fallacy_name) ? "an" : "a";
    return `Foul! That's ${article} ${f.fallacy_name}. ${f.explanation}`;
  }
  const lead =
    f.verdict === "false"
      ? "Stop right there — that's a lie! Here's the truth:"
      : f.verdict === "misleading"
        ? "Hold on — that's misleading. Actually:"
        : "Careful — that claim can't be verified.";
  const source = f.source_name ? ` Source: ${f.source_name}.` : "";
  return `${lead} ${f.correction}${source}`;
}

export default function Home() {
  const { supported, listening, transcript, interim, error, start, stop, reset } =
    useSpeech();

  const [sessionActive, setSessionActive] = useState(false);
  const [findings, setFindings] = useState<PlacedFinding[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [voice, setVoice] = useState(true);
  const [speakingFinding, setSpeakingFinding] = useState<Finding | null>(null);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [allClear, setAllClear] = useState<string | null>(null);
  const allClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const analyzedRef = useRef(0);
  const lastChunkRef = useRef("");
  const pendingSinceRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const seenQuotesRef = useRef<Set<string>>(new Set());
  const nextIdRef = useRef(1);
  const voiceRef = useRef(voice);
  const sessionActiveRef = useRef(false);
  const speakQueueRef = useRef<Finding[]>([]);
  const speakingRef = useRef(false);
  const transcriptElRef = useRef<HTMLDivElement>(null);

  transcriptRef.current = transcript;
  interimRef.current = interim;
  voiceRef.current = voice;
  sessionActiveRef.current = sessionActive;

  // Pre-pick an English TTS voice; voices often load async.
  const ttsVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      ttsVoiceRef.current =
        voices.find(
          (v) => v.lang.startsWith("en") && /Google US|Samantha|Aria|Zira/i.test(v.name)
        ) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        voices[0] ??
        null;
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  // Verify server setup once on load so a missing key never fails silently.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setAiConfigured(!!h.ai))
      .catch(() => setAiConfigured(null));
  }, []);

  const chime = useCallback(() => {
    try {
      type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
      const Ctx = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => ctx.close();
    } catch {
      /* audio is best-effort */
    }
    if (navigator.vibrate) navigator.vibrate(200);
  }, []);

  /** Sharp game-show buzzer that cuts through mid-conversation talking. */
  const buzzer = useCallback(() => {
    try {
      type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
      const Ctx = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.setValueAtTime(160, ctx.currentTime + 0.18);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
      osc.onended = () => ctx.close();
    } catch {
      /* audio is best-effort */
    }
  }, []);

  /* ── Spoken interruptions ─────────────────────────────────────────────
     While the referee talks, speech recognition is paused so the app
     doesn't transcribe (and fact-check) its own voice. */
  const drainSpeakQueue = useCallback(() => {
    if (speakingRef.current) return;
    const next = speakQueueRef.current.shift();
    if (!next) {
      if (sessionActiveRef.current) start(); // resume listening
      return;
    }
    speakingRef.current = true;
    stop(); // pause recognition while we talk
    setSpeakingFinding(next);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    buzzer(); // grab the room's attention before speaking

    const utter = new SpeechSynthesisUtterance(ttsText(next));
    utter.rate = 1.05;
    utter.volume = 1;
    utter.lang = "en-US";
    if (ttsVoiceRef.current) utter.voice = ttsVoiceRef.current;

    // Chrome silently pauses long utterances; nudge it while speaking.
    const keepAlive = setInterval(() => window.speechSynthesis.resume(), 4000);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearInterval(keepAlive);
      clearTimeout(watchdog);
      speakingRef.current = false;
      setSpeakingFinding(null);
      drainSpeakQueue();
    };
    // Some browsers never fire onend after a cancel — don't wedge the queue.
    const watchdog = setTimeout(() => {
      window.speechSynthesis.cancel();
      done();
    }, 25000);
    utter.onend = done;
    utter.onerror = done;
    // small beat after the buzzer so the callout isn't drowned out
    setTimeout(() => {
      window.speechSynthesis.cancel(); // clear any stuck queue first
      window.speechSynthesis.speak(utter);
    }, 450);
  }, [start, stop, buzzer]);

  const interrupt = useCallback(
    (fresh: Finding[]) => {
      if (voiceRef.current && "speechSynthesis" in window) {
        speakQueueRef.current.push(...fresh);
        drainSpeakQueue();
      } else {
        chime();
      }
    },
    [drainSpeakQueue, chime]
  );

  const skipSpeaking = useCallback(() => {
    window.speechSynthesis.cancel(); // fires onend/onerror → queue drains
  }, []);

  /* ── Analysis loop ──────────────────────────────────────────────────── */
  const analyze = useCallback(async () => {
    if (inFlightRef.current) return;
    const finalText = transcriptRef.current;
    // Include words still being spoken so continuous talkers get checked
    // without waiting for a pause. Only finalized text advances the analyzed
    // pointer — the live tail is re-sent next tick and deduped by quote.
    const live = interimRef.current.trim();
    const combined = live ? `${finalText} ${live}` : finalText;
    const chunk = combined.slice(analyzedRef.current).trim();
    if (!chunk) return;
    if (chunk === lastChunkRef.current) return; // nothing new since last send

    const pendingSince = pendingSinceRef.current ?? Date.now();
    pendingSinceRef.current = pendingSince;
    const waitedLongEnough = Date.now() - pendingSince >= MAX_WAIT_MS;
    if (chunk.length < MIN_CHUNK_CHARS && !waitedLongEnough) return;

    inFlightRef.current = true;
    lastChunkRef.current = chunk;
    const sentUpTo = finalText.length;
    setAnalyzing(true);
    try {
      const context = finalText
        .slice(Math.max(0, analyzedRef.current - CONTEXT_CHARS), analyzedRef.current)
        .trim();
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk, context }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setApiError(data?.error ?? `Analysis failed (HTTP ${res.status})`);
        return;
      }
      setApiError(null);
      analyzedRef.current = sentUpTo;
      pendingSinceRef.current = null;

      const data: AnalyzeResponse = await res.json();
      const fresh = data.findings.filter((f) => {
        const key = `${f.type}:${normalizeQuote(f.quote)}`;
        if (seenQuotesRef.current.has(key)) return false;
        seenQuotesRef.current.add(key);
        return true;
      });
      if (fresh.length > 0) {
        setFindings((prev) => [
          ...prev,
          ...fresh.map((finding) => ({
            id: nextIdRef.current++,
            finding,
            offset: sentUpTo,
          })),
        ]);
        interrupt(fresh);
      } else if ((data.claims_checked ?? 0) > 0) {
        // Prove the referee is working even when nobody is wrong.
        const n = data.claims_checked!;
        setAllClear(`✓ ${n} claim${n === 1 ? "" : "s"} checked — all accurate`);
        if (allClearTimerRef.current) clearTimeout(allClearTimerRef.current);
        allClearTimerRef.current = setTimeout(() => setAllClear(null), 8000);
      }
    } catch {
      setApiError("Network error while analyzing. Retrying…");
    } finally {
      inFlightRef.current = false;
      setAnalyzing(false);
    }
  }, [interrupt]);

  useEffect(() => {
    if (!sessionActive) return;
    const timer = setInterval(analyze, ANALYZE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionActive, analyze]);

  /* ── Session controls ───────────────────────────────────────────────── */
  const handleStart = useCallback(() => {
    setApiError(null);
    setSessionActive(true);
    // Unlock speech synthesis on this user gesture (required on iOS):
    // speaking a silent utterance from a tap grants audio for later callouts.
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      window.speechSynthesis.speak(unlock);
    }
    start();
  }, [start]);

  const handleStop = useCallback(() => {
    setSessionActive(false);
    speakQueueRef.current = [];
    window.speechSynthesis?.cancel();
    stop();
    pendingSinceRef.current = 0; // force the final short chunk through
    void analyze();
  }, [stop, analyze]);

  const handleReset = useCallback(() => {
    reset();
    setFindings([]);
    setApiError(null);
    analyzedRef.current = 0;
    lastChunkRef.current = "";
    pendingSinceRef.current = null;
    seenQuotesRef.current.clear();
  }, [reset]);

  // Keep the newest words in view.
  useEffect(() => {
    const el = transcriptElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, interim, findings]);

  /* ── Render: transcript with findings woven in at their offsets ─────── */
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const pf of findings) {
    const text = transcript.slice(cursor, pf.offset).trim();
    if (text) segments.push(<span key={`t${pf.id}`}>{text} </span>);
    cursor = Math.max(cursor, pf.offset);
    const f = pf.finding;
    segments.push(
      <span
        key={`f${pf.id}`}
        className={`inline-card v-${f.type === "fallacy" ? "fallacy" : f.verdict}`}
      >
        <span className="tag">
          {f.type === "fallacy"
            ? `⚠ ${f.fallacy_name}`
            : `✗ ${VERDICT_LABEL[f.verdict]}`}
        </span>
        <span className="body">
          {f.type === "fallacy" ? f.explanation : f.correction}
        </span>
        {f.type === "fact_check" && f.source_name && (
          <span className="source">
            {f.source_url ? (
              <a href={f.source_url} target="_blank" rel="noreferrer">
                {f.source_name}
              </a>
            ) : (
              f.source_name
            )}
          </span>
        )}
      </span>
    );
  }
  const tailText = transcript.slice(cursor).trim();

  return (
    <main className="stage">
      {aiConfigured === false && (
        <div className="setup-banner">
          <strong>Setup needed:</strong> no AI key is configured, so nothing will
          be fact-checked. Add <code>GEMINI_API_KEY</code> (free at{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>
          ) or <code>NVIDIA_NIM_API_KEY</code> to your environment variables and
          redeploy. Web-search keys are optional.
        </div>
      )}
      {!supported && (
        <div className="setup-banner">
          This browser doesn&apos;t support live speech recognition. Use Chrome,
          Edge, or Safari.
        </div>
      )}
      {(error || apiError) && <div className="error-banner">{error ?? apiError}</div>}

      <div className="transcript" ref={transcriptElRef}>
        {transcript || interim || findings.length > 0 ? (
          <p>
            {segments}
            {tailText && <span>{tailText} </span>}
            {interim && <span className="interim">{interim}</span>}
          </p>
        ) : (
          <div className="hint">
            <div className="mark">⚖️</div>
            <p>
              Place the phone between you, press the mic, and debate. Everything
              said appears here — and when someone gets a fact wrong or slips
              into a fallacy, the referee interrupts out loud with the
              correction and its source.
            </p>
          </div>
        )}
      </div>

      <div className="dock">
        <WaveBar active={sessionActive} />
        <div className="controls">
          <button
            className={`side-btn ${voice ? "active" : ""}`}
            onClick={() => setVoice((v) => !v)}
            title="Spoken interruptions"
          >
            {voice ? "🔊 Voice" : "🔇 Muted"}
          </button>
          <button
            className={`mic-btn ${sessionActive ? "listening" : ""}`}
            onClick={sessionActive ? handleStop : handleStart}
            disabled={!supported}
            aria-label={sessionActive ? "Stop" : "Start listening"}
          >
            {sessionActive ? "■" : "🎙"}
          </button>
          <button className="side-btn" onClick={handleReset} title="Clear session">
            ✕ Clear
          </button>
        </div>
        <div className={`status ${analyzing ? "thinking" : ""}`}>
          {speakingFinding
            ? "Referee speaking…"
            : analyzing
              ? "Fact-checking…"
              : sessionActive
                ? listening
                  ? (allClear ?? "Listening")
                  : "Paused"
                : "Mic off"}
        </div>
      </div>

      {speakingFinding && (
        <div className="interrupt-overlay" onClick={skipSpeaking}>
          <div
            className={`interrupt-card v-${
              speakingFinding.type === "fallacy" ? "fallacy" : speakingFinding.verdict
            }`}
          >
            <span className="tag">
              {speakingFinding.type === "fallacy"
                ? `⚠ ${speakingFinding.fallacy_name}`
                : `✗ ${VERDICT_LABEL[speakingFinding.verdict]}`}
            </span>
            <blockquote>&ldquo;{speakingFinding.quote}&rdquo;</blockquote>
            <div className="body">
              {speakingFinding.type === "fallacy"
                ? speakingFinding.explanation
                : speakingFinding.correction}
            </div>
            {speakingFinding.type === "fact_check" && speakingFinding.source_name && (
              <div className="source">Source: {speakingFinding.source_name}</div>
            )}
            <div className="skip">tap to skip</div>
          </div>
        </div>
      )}
    </main>
  );
}
