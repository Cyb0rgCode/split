"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeech } from "@/lib/useSpeech";
import type { AnalyzeResponse, Finding } from "@/lib/types";

interface Alert {
  id: number;
  finding: Finding;
  at: Date;
}

const ANALYZE_INTERVAL_MS = 6000;
const MIN_CHUNK_CHARS = 60;
const MAX_WAIT_MS = 15000;
const CONTEXT_CHARS = 1500;

const VERDICT_LABEL: Record<string, string> = {
  false: "False claim",
  misleading: "Misleading",
  unverifiable: "Unverifiable",
};

function normalizeQuote(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export default function Home() {
  const { supported, listening, transcript, interim, error, start, stop, reset } =
    useSpeech();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const [sound, setSound] = useState(true);

  const transcriptRef = useRef("");
  const analyzedRef = useRef(0);
  const pendingSinceRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const seenQuotesRef = useRef<Set<string>>(new Set());
  const nextIdRef = useRef(1);
  const soundRef = useRef(sound);
  const feedRef = useRef<HTMLDivElement>(null);

  transcriptRef.current = transcript;
  soundRef.current = sound;

  const chime = useCallback(() => {
    if (!soundRef.current) return;
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

  const analyze = useCallback(async () => {
    if (inFlightRef.current) return;
    const full = transcriptRef.current;
    const chunk = full.slice(analyzedRef.current).trim();
    if (!chunk) return;

    const pendingSince = pendingSinceRef.current ?? Date.now();
    pendingSinceRef.current = pendingSince;
    const waitedLongEnough = Date.now() - pendingSince >= MAX_WAIT_MS;
    if (chunk.length < MIN_CHUNK_CHARS && !waitedLongEnough) return;

    inFlightRef.current = true;
    const sentUpTo = full.length;
    setAnalyzing(true);
    try {
      const context = full
        .slice(Math.max(0, analyzedRef.current - CONTEXT_CHARS), analyzedRef.current)
        .trim();
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk, context }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setApiError(data?.error ?? `Analysis failed (${res.status})`);
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
        setAlerts((prev) => [
          ...prev,
          ...fresh.map((finding) => ({
            id: nextIdRef.current++,
            finding,
            at: new Date(),
          })),
        ]);
        chime();
      }
    } catch {
      setApiError("Network error while analyzing. Retrying…");
    } finally {
      inFlightRef.current = false;
      setAnalyzing(false);
    }
  }, [chime]);

  // Poll for un-analyzed speech while listening.
  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(analyze, ANALYZE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [listening, analyze]);

  // Flush whatever is left when the mic is turned off.
  const handleStop = useCallback(() => {
    stop();
    pendingSinceRef.current = 0; // force the final short chunk through
    void analyze();
  }, [stop, analyze]);

  const handleStart = useCallback(() => {
    setApiError(null);
    start();
  }, [start]);

  const handleReset = useCallback(() => {
    reset();
    setAlerts([]);
    setApiError(null);
    analyzedRef.current = 0;
    pendingSinceRef.current = null;
    seenQuotesRef.current.clear();
  }, [reset]);

  // Keep the newest alert in view.
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTop = mirrored ? 0 : feed.scrollHeight;
  }, [alerts, mirrored]);

  const tail = (transcript.slice(-220) + " " + interim).trim();

  return (
    <main className="app">
      <header className="header">
        <div className="brand">
          <h1>SPLIT</h1>
          <span>AI debate referee</span>
        </div>
        <div className="header-actions">
          <button
            className={`icon-btn ${sound ? "active" : ""}`}
            onClick={() => setSound((s) => !s)}
            title="Alert sound"
          >
            {sound ? "🔔 On" : "🔕 Off"}
          </button>
          <button
            className={`icon-btn ${mirrored ? "active" : ""}`}
            onClick={() => setMirrored((m) => !m)}
            title="Rotate the feed 180° so your opponent can read it"
          >
            ↕ Flip
          </button>
          <button className="icon-btn" onClick={handleReset} title="Clear session">
            ✕ Clear
          </button>
        </div>
      </header>

      {!supported && (
        <div className="error-banner">
          This browser doesn&apos;t support live speech recognition. Use Chrome,
          Edge, or Safari on your phone.
        </div>
      )}
      {(error || apiError) && <div className="error-banner">{error ?? apiError}</div>}

      <div className={`feed ${mirrored ? "mirrored" : ""}`} ref={feedRef}>
        {alerts.length === 0 ? (
          <div className="empty-state">
            <div className="big">⚖️</div>
            <h2>Place the phone between you and your opponent</h2>
            <p>
              Hit <strong>Start listening</strong> and debate normally. When
              someone states a false claim or statistic, Split posts the
              correction with a source. When someone commits a logical fallacy —
              ad hominem, straw man, false dilemma — Split calls it out. No
              alerts means the debate is clean. 👏
            </p>
          </div>
        ) : (
          alerts.map(({ id, finding, at }) => (
            <div
              key={id}
              className={`card v-${
                finding.type === "fallacy" ? "fallacy" : finding.verdict
              }`}
            >
              <span className="card-tag">
                {finding.type === "fallacy"
                  ? `⚠ ${finding.fallacy_name}`
                  : `✗ ${VERDICT_LABEL[finding.verdict]}`}
              </span>
              <blockquote>&ldquo;{finding.quote}&rdquo;</blockquote>
              <div className="body">
                {finding.type === "fallacy" ? finding.explanation : finding.correction}
              </div>
              {finding.type === "fact_check" && finding.source_name && (
                <div className="source">
                  Source:{" "}
                  {finding.source_url ? (
                    <a href={finding.source_url} target="_blank" rel="noreferrer">
                      {finding.source_name}
                    </a>
                  ) : (
                    finding.source_name
                  )}
                </div>
              )}
              <div className="time">
                {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          ))
        )}
      </div>

      {listening && (
        <div className="transcript-strip">
          <div className="live-dot" />
          <div className="words">
            {tail ? (
              <>
                {transcript.slice(-220)}
                <span className="interim"> {interim}</span>
              </>
            ) : (
              "Listening…"
            )}
          </div>
        </div>
      )}

      <footer className="controls">
        <button
          className={`mic-btn ${listening ? "listening" : ""}`}
          onClick={listening ? handleStop : handleStart}
          disabled={!supported}
        >
          {listening ? "■ Stop" : "🎙 Start listening"}
        </button>
        <span className={`status-note ${analyzing ? "thinking" : ""}`}>
          {analyzing ? "Fact-checking…" : listening ? "Referee active" : "Mic off"}
        </span>
      </footer>
    </main>
  );
}
