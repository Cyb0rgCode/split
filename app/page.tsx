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

// Gemini free tier allows 15 requests/min — 5s ticks keep us safely under.
const ANALYZE_INTERVAL_MS = 5000;
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

type VoiceMode = "off" | "browser" | "elevenlabs" | "gemini";

interface VoicePick {
  browser: string; // voice name, "" = auto
  elevenlabs: string; // voice id
  gemini: string; // prebuilt voice name
}

const ELEVENLABS_VOICES: Array<{ id: string; name: string }> = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "9BWtsMINqrJLrRacOk9x", name: "Aria" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
];

const GEMINI_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Zephyr"];

const MODE_LABEL: Record<VoiceMode, string> = {
  off: "🔇 Off",
  browser: "🔊 Browser",
  elevenlabs: "🔊 11Labs",
  gemini: "🔊 Gemini",
};

export default function Home() {
  /* What the referee is currently saying out loud. Recognition keeps running
     while it speaks, so segments that are mostly the referee's own words are
     scrubbed from the transcript instead of being fact-checked back at it. */
  const calloutTextRef = useRef("");
  const echoFilter = useCallback((text: string) => {
    const spoken = calloutTextRef.current;
    if (!spoken) return text;
    const spokenWords = new Set(normalizeQuote(spoken).split(" "));
    const words = normalizeQuote(text).split(" ").filter(Boolean);
    if (words.length === 0) return text;
    const matches = words.filter((w) => spokenWords.has(w)).length;
    return matches / words.length > 0.5 ? "" : text;
  }, []);

  const { supported, listening, transcript, interim, error, start, stop, reset } =
    useSpeech("en-US", echoFilter);

  const [sessionActive, setSessionActive] = useState(false);
  const [findings, setFindings] = useState<PlacedFinding[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("browser");
  const [voicePick, setVoicePick] = useState<VoicePick>({
    browser: "",
    elevenlabs: ELEVENLABS_VOICES[0].id,
    gemini: GEMINI_VOICES[0],
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [browserVoices, setBrowserVoices] = useState<string[]>([]);
  const [ttsAvailable, setTtsAvailable] = useState({
    elevenlabs: false,
    gemini: false,
  });
  const [speakingFinding, setSpeakingFinding] = useState<Finding | null>(null);
  const [viewedFinding, setViewedFinding] = useState<Finding | null>(null);
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
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const voicePickRef = useRef<VoicePick>(voicePick);
  const sessionActiveRef = useRef(false);
  const speakQueueRef = useRef<Finding[]>([]);
  const speakingRef = useRef(false);
  const transcriptElRef = useRef<HTMLDivElement>(null);

  transcriptRef.current = transcript;
  interimRef.current = interim;
  voiceModeRef.current = voiceMode;
  voicePickRef.current = voicePick;
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
      setBrowserVoices(
        voices.filter((v) => v.lang.startsWith("en")).map((v) => v.name)
      );
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  // Restore the voice choice from the last session.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("split-voice") ?? "null");
      if (saved?.mode) setVoiceMode(saved.mode as VoiceMode);
      if (saved?.pick) setVoicePick((p) => ({ ...p, ...saved.pick }));
    } catch {
      /* corrupted storage — keep defaults */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "split-voice",
        JSON.stringify({ mode: voiceMode, pick: voicePick })
      );
    } catch {
      /* private mode — not persisted */
    }
  }, [voiceMode, voicePick]);

  // Verify server setup once on load so a missing key never fails silently.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        setAiConfigured(!!h.ai);
        setTtsAvailable({
          elevenlabs: !!h.tts?.elevenlabs,
          gemini: !!h.tts?.gemini,
        });
      })
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

  /** Sharp game-show buzzer — fallback if the alert sound file fails. */
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

  /* Alert sound played before the referee speaks. Fetched once and decoded
     lazily against the shared playback AudioContext. */
  const alertBytesRef = useRef<ArrayBuffer | null>(null);
  const alertBufferRef = useRef<AudioBuffer | null>(null);
  const alertSourceRef = useRef<AudioBufferSourceNode | null>(null);
  useEffect(() => {
    fetch("/alert.mp3")
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((bytes) => {
        alertBytesRef.current = bytes;
      })
      .catch(() => {});
  }, []);

  /** Plays the alert sound to completion; falls back to the buzzer. */
  const playAlert = useCallback(async (): Promise<void> => {
    const ctx = audioCtxRef.current;
    try {
      if (ctx) {
        if (ctx.state === "suspended") await ctx.resume();
        if (!alertBufferRef.current && alertBytesRef.current) {
          // decodeAudioData detaches the buffer — hand it a copy
          alertBufferRef.current = await ctx.decodeAudioData(
            alertBytesRef.current.slice(0)
          );
        }
        const buffer = alertBufferRef.current;
        if (buffer) {
          await new Promise<void>((resolve) => {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            alertSourceRef.current = src;
            const safety = setTimeout(resolve, buffer.duration * 1000 + 500);
            src.onended = () => {
              clearTimeout(safety);
              alertSourceRef.current = null;
              resolve();
            };
            src.start();
          });
          return;
        }
      }
    } catch {
      /* fall through to the buzzer */
    }
    buzzer();
    await new Promise((r) => setTimeout(r, 450));
  }, [buzzer]);

  /* ── Spoken interruptions ─────────────────────────────────────────────
     Gemini TTS first (natural voice), browser speech synthesis as the
     fallback when the TTS quota is spent or the request fails. While the
     referee talks, speech recognition is paused so the app doesn't
     transcribe (and fact-check) its own voice. */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const playRemoteTts = useCallback(async (text: string): Promise<boolean> => {
    try {
      const mode = voiceModeRef.current;
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          provider: mode,
          voice:
            mode === "elevenlabs"
              ? voicePickRef.current.elevenlabs
              : voicePickRef.current.gemini,
        }),
        signal: AbortSignal.timeout(15000), // slow TTS → fall back, don't stall
      });
      if (!res.ok) return false;
      const wav = await res.arrayBuffer();
      const ctx = audioCtxRef.current;
      if (!ctx) return false;
      if (ctx.state === "suspended") await ctx.resume();
      const buffer = await ctx.decodeAudioData(wav);
      return await new Promise<boolean>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        ttsSourceRef.current = src;
        src.onended = () => {
          ttsSourceRef.current = null;
          resolve(true);
        };
        src.start();
      });
    } catch {
      return false;
    }
  }, []);

  const speakWithBrowserTts = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      utter.volume = 1;
      utter.lang = "en-US";
      const pickedName = voicePickRef.current.browser;
      const picked = pickedName
        ? window.speechSynthesis.getVoices().find((v) => v.name === pickedName)
        : null;
      const chosen = picked ?? ttsVoiceRef.current;
      if (chosen) utter.voice = chosen;

      // Chrome silently pauses long utterances; nudge it while speaking.
      const keepAlive = setInterval(() => window.speechSynthesis.resume(), 4000);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(keepAlive);
        clearTimeout(watchdog);
        resolve();
      };
      // Some browsers never fire onend after a cancel — don't wedge the queue.
      const watchdog = setTimeout(() => {
        window.speechSynthesis.cancel();
        done();
      }, 25000);
      utter.onend = done;
      utter.onerror = done;
      window.speechSynthesis.cancel(); // clear any stuck queue first
      window.speechSynthesis.speak(utter);
    });
  }, []);

  const calloutClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainSpeakQueue = useCallback(() => {
    if (speakingRef.current) return;
    const next = speakQueueRef.current.shift();
    if (!next) return;
    speakingRef.current = true;
    // Recognition keeps running in parallel — the echo filter scrubs the
    // referee's own voice so the debaters' words are never lost.
    setSpeakingFinding(next);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);

    void (async () => {
      const text = ttsText(next);
      if (calloutClearTimerRef.current) clearTimeout(calloutClearTimerRef.current);
      calloutTextRef.current = text;
      // grab the room's attention, then a small beat before the callout
      await playAlert();
      await new Promise((r) => setTimeout(r, 150));
      const mode = voiceModeRef.current;
      // AI providers fall back to the browser voice; browser mode goes direct.
      const spoken = mode === "browser" ? false : await playRemoteTts(text);
      if (!spoken) await speakWithBrowserTts(text);
      // recognition finals lag behind the audio — keep filtering briefly
      calloutClearTimerRef.current = setTimeout(() => {
        if (!speakingRef.current) calloutTextRef.current = "";
      }, 2500);
      speakingRef.current = false;
      setSpeakingFinding(null);
      drainSpeakQueue();
    })();
  }, [playAlert, playRemoteTts, speakWithBrowserTts]);

  const interrupt = useCallback(
    (fresh: Finding[]) => {
      if (voiceModeRef.current !== "off") {
        speakQueueRef.current.push(...fresh);
        drainSpeakQueue();
      } else {
        chime();
      }
    },
    [drainSpeakQueue, chime]
  );

  const skipSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel(); // fires onend/onerror → queue drains
    try {
      ttsSourceRef.current?.stop(); // fires onended → queue drains
    } catch {
      /* already stopped */
    }
    try {
      alertSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
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
    // Unlock audio output on this user gesture (required on iOS): resume the
    // playback AudioContext for Gemini TTS and speak a silent utterance so
    // browser speech synthesis is also allowed for later callouts.
    type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (Ctx && !audioCtxRef.current) audioCtxRef.current = new Ctx();
    void audioCtxRef.current?.resume().catch(() => {});
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
    try {
      ttsSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    try {
      alertSourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
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
        role="button"
        tabIndex={0}
        onClick={() => setViewedFinding(f)}
        onKeyDown={(e) => e.key === "Enter" && setViewedFinding(f)}
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
              <a
                href={f.source_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
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
            className={`side-btn ${voiceMode !== "off" ? "active" : ""}`}
            onClick={() => setPickerOpen(true)}
            title="Choose the referee's voice"
          >
            {MODE_LABEL[voiceMode]}
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

      {pickerOpen && (
        <div className="picker-overlay" onClick={() => setPickerOpen(false)}>
          <div className="picker-card" onClick={(e) => e.stopPropagation()}>
            <h2>Referee voice</h2>

            <label className={`picker-row ${voiceMode === "browser" ? "selected" : ""}`}>
              <input
                type="radio"
                name="voice-mode"
                checked={voiceMode === "browser"}
                onChange={() => setVoiceMode("browser")}
              />
              <span className="row-main">
                <span className="row-title">Browser voice</span>
                <span className="row-sub">Free, instant, on-device (default)</span>
              </span>
            </label>
            {voiceMode === "browser" && browserVoices.length > 0 && (
              <select
                className="picker-select"
                value={voicePick.browser}
                onChange={(e) =>
                  setVoicePick((p) => ({ ...p, browser: e.target.value }))
                }
              >
                <option value="">Auto (recommended)</option>
                {browserVoices.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}

            <label
              className={`picker-row ${voiceMode === "elevenlabs" ? "selected" : ""} ${
                ttsAvailable.elevenlabs ? "" : "disabled"
              }`}
            >
              <input
                type="radio"
                name="voice-mode"
                disabled={!ttsAvailable.elevenlabs}
                checked={voiceMode === "elevenlabs"}
                onChange={() => setVoiceMode("elevenlabs")}
              />
              <span className="row-main">
                <span className="row-title">ElevenLabs</span>
                <span className="row-sub">
                  {ttsAvailable.elevenlabs
                    ? "Most natural — ~80 callouts/month free"
                    : "Add ELEVENLABS_API_KEY to enable"}
                </span>
              </span>
            </label>
            {voiceMode === "elevenlabs" && (
              <select
                className="picker-select"
                value={voicePick.elevenlabs}
                onChange={(e) =>
                  setVoicePick((p) => ({ ...p, elevenlabs: e.target.value }))
                }
              >
                {ELEVENLABS_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}

            <label
              className={`picker-row ${voiceMode === "gemini" ? "selected" : ""} ${
                ttsAvailable.gemini ? "" : "disabled"
              }`}
            >
              <input
                type="radio"
                name="voice-mode"
                disabled={!ttsAvailable.gemini}
                checked={voiceMode === "gemini"}
                onChange={() => setVoiceMode("gemini")}
              />
              <span className="row-main">
                <span className="row-title">Gemini TTS</span>
                <span className="row-sub">
                  {ttsAvailable.gemini
                    ? "Natural — ~10 callouts/day per model, free"
                    : "Add GEMINI_API_KEY to enable"}
                </span>
              </span>
            </label>
            {voiceMode === "gemini" && (
              <select
                className="picker-select"
                value={voicePick.gemini}
                onChange={(e) =>
                  setVoicePick((p) => ({ ...p, gemini: e.target.value }))
                }
              >
                {GEMINI_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}

            <label className={`picker-row ${voiceMode === "off" ? "selected" : ""}`}>
              <input
                type="radio"
                name="voice-mode"
                checked={voiceMode === "off"}
                onChange={() => setVoiceMode("off")}
              />
              <span className="row-main">
                <span className="row-title">Off</span>
                <span className="row-sub">Chime + vibration only</span>
              </span>
            </label>

            <div className="picker-actions">
              <button
                className="side-btn"
                disabled={voiceMode === "off" || speakingRef.current}
                onClick={() => {
                  void (async () => {
                    const sample = "Fact check. This is your debate referee speaking.";
                    type AudioWindow = Window & {
                      webkitAudioContext?: typeof AudioContext;
                    };
                    const Ctx =
                      window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
                    if (Ctx && !audioCtxRef.current) audioCtxRef.current = new Ctx();
                    void audioCtxRef.current?.resume().catch(() => {});
                    const ok =
                      voiceMode === "browser" ? false : await playRemoteTts(sample);
                    if (!ok) await speakWithBrowserTts(sample);
                  })();
                }}
              >
                ▶ Test voice
              </button>
              <button className="side-btn active" onClick={() => setPickerOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {viewedFinding && !speakingFinding && (
        <div className="interrupt-overlay" onClick={() => setViewedFinding(null)}>
          <div
            className={`interrupt-card v-${
              viewedFinding.type === "fallacy" ? "fallacy" : viewedFinding.verdict
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="tag">
              {viewedFinding.type === "fallacy"
                ? `⚠ ${viewedFinding.fallacy_name}`
                : `✗ ${VERDICT_LABEL[viewedFinding.verdict]}`}
            </span>
            <blockquote>&ldquo;{viewedFinding.quote}&rdquo;</blockquote>
            <div className="body">
              {viewedFinding.type === "fallacy"
                ? viewedFinding.explanation
                : viewedFinding.correction}
            </div>
            {viewedFinding.type === "fact_check" && viewedFinding.source_name && (
              <div className="source">
                Source:{" "}
                {viewedFinding.source_url ? (
                  <a href={viewedFinding.source_url} target="_blank" rel="noreferrer">
                    {viewedFinding.source_name}
                  </a>
                ) : (
                  viewedFinding.source_name
                )}
              </div>
            )}
            <div className="picker-actions">
              <button
                className="side-btn"
                onClick={() => {
                  const f = viewedFinding;
                  setViewedFinding(null);
                  speakQueueRef.current.push(f);
                  drainSpeakQueue();
                }}
              >
                🔊 Replay
              </button>
              <button className="side-btn active" onClick={() => setViewedFinding(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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
