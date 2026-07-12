# ⚖️ Split — the AI debate referee

Place your phone between you and your debate opponent. Split listens to the
conversation and, in real time:

- **Fact-checks false claims and statistics** — when someone states something
  incorrect, the referee **interrupts out loud**, speaking the correct
  claim/statistic and its source, while the correction card appears inline in
  the transcript.
- **Calls out logical fallacies** — ad hominem, straw man, false dilemma,
  whataboutism, slippery slope, and more, each with a one-line explanation of
  why it's a fallacy.

The UI is a single full-page live transcript with a wave bar at the bottom
that illuminates while the debaters talk.

No alerts means the debate is clean. Better debates for both sides.

## How it works

1. The browser's built-in **Web Speech API** transcribes the debate live on
   your phone — no audio ever leaves the device.
2. Every few seconds, the new slice of transcript is sent to a serverless API
   route (`/api/analyze`).
3. The route asks **Google Gemini** (or **NVIDIA NIM**) — both have free
   tiers — to flag only clear-cut false claims and fallacies, and returns
   structured JSON.
4. Each flagged claim is then run through a **live web search** (Tavily or
   the keyless Wikipedia API) so the cited source is a real, current
   result — not the model's memory.
5. New findings interrupt the debate mid-conversation: a sharp buzzer cuts
   through the talking, then the referee **calls the lie out loud** —
   "Stop right there, that's a lie! Here's the truth: …" — followed by the
   correction and source, shown full-screen while it speaks. The **Voice
   button opens a picker** for the provider and the specific voice, all free:
   - **Browser voice** (default) — instant, on-device, pick any installed
     English voice
   - **ElevenLabs** — most natural; needs `ELEVENLABS_API_KEY` (free plan:
     10,000 credits/month ≈ 80 callouts;
     [elevenlabs.io/app/developers](https://elevenlabs.io/app/developers));
     George, Aria, Sarah, Charlie, or Brian
   - **Gemini TTS** — natural; uses your existing `GEMINI_API_KEY` (≈10
     callouts/day per model, and the app stacks the model quotas); Kore,
     Puck, Charon, Fenrir, Aoede, or Zephyr
   - **Off** — chime + vibration only

   AI voices fall back to the browser voice automatically on quota/errors,
   there's a ▶ Test button in the picker, and the choice is remembered on
   the device. Listening pauses during the callout and resumes after.
   The card also stays woven into the transcript at the point where it
   happened. Toggle **Voice** off for a chime + vibration instead.
   Customize with `ELEVENLABS_VOICE_ID` (default: George — browse the
   [voice library](https://elevenlabs.io/app/voice-library)),
   `GEMINI_TTS_VOICE` (default `Kore`), or `GEMINI_TTS_MODEL`.

## Setup

```bash
npm install
cp .env.example .env.local   # then add ONE of the keys below
npm run dev
```

Set **one** provider in `.env.local`:

| Variable | Where to get it | Default model |
| --- | --- | --- |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free) | `gemini-3.1-flash-lite` |
| `NVIDIA_NIM_API_KEY` | [build.nvidia.com](https://build.nvidia.com) (free credits) | `meta/llama-3.3-70b-instruct` |

Gemini is used if both are set. Override the model with `GEMINI_MODEL` /
`NVIDIA_NIM_MODEL` if you like.

### Web search for sources (optional, free)

Fact-check cards link to a live web search result. Out of the box this uses
the **keyless Wikipedia search API** — no signup at all. For broader,
higher-quality sources add:

| Variable | Free tier |
| --- | --- |
| `TAVILY_API_KEY` | 1,000 credits/month — [tavily.com](https://tavily.com) |

Tavily is used when set; on failure it falls back to Wikipedia.

Open `http://localhost:3000`, allow microphone access, press
**Start listening**, and start arguing.

> Live speech recognition requires Chrome, Edge, or Safari (desktop or
> mobile). Firefox doesn't ship the Web Speech API yet.

## Deploy to Vercel

1. Push this repo to GitHub.
2. [Import it into Vercel](https://vercel.com/new) — it's auto-detected as a
   Next.js app; no configuration needed.
3. In **Project → Settings → Environment Variables**, add `GEMINI_API_KEY`
   (or `NVIDIA_NIM_API_KEY`).
4. Deploy. The mic works on the deployed URL because Vercel serves over HTTPS
   (browsers only allow microphone access on secure origins).

## Nothing happening? Troubleshooting

- **No AI key configured** is the #1 cause — the app shows a yellow setup
  banner on load if so. Add `GEMINI_API_KEY` in Vercel → Settings →
  Environment Variables and **redeploy** (env changes don't apply to old
  deployments). Web-search keys are *optional* and never the blocker.
- Any provider error (bad key, quota, model) now appears as a red banner with
  the actual error message instead of failing silently.
- Analysis runs every ~6 seconds once ~60 characters of *finalized* speech
  accumulate — say a full sentence or two and give it a beat.
- The referee is deliberately conservative: opinions and vague claims are
  ignored. Test it with something concrete and clearly wrong, e.g. "the Great
  Wall of China is visible from the Moon" or "unemployment is 40 percent".
- **Measure it instead of guessing:** `node scripts/eval.mjs
  https://your-app.vercel.app` sends 10 famous myths plus 2 controls at the
  analyzer and prints which were caught (uses ~12 free-tier requests). If
  recall is low, set `GEMINI_MODEL=gemini-3.5-flash` — much sharper, but its
  free tier is only ~20 requests/day, so it suits demos over daily use.
- Speech recognition needs Chrome, Edge, or Safari over HTTPS (or localhost),
  with mic permission granted.
- **Hearing the robotic browser voice instead of the AI voice?** Open
  `/api/tts` in your browser on the deployed site — it runs a live self-test
  and reports exactly which TTS provider works and the upstream error for
  each one that doesn't (spent quota, invalid key, renamed model, …).

## Notes & limits

- The AI is prompted to be **conservative**: opinions, predictions, and
  hyperbole are never flagged — only concrete, checkable claims and clear-cut
  fallacies.
- Sources come from a live web search (authoritative domains are preferred
  when picking the result to cite); still, treat them as a starting point and
  verify anything that matters.
- Speech recognition quality depends on the device mic, distance, and
  crosstalk — put the phone roughly equidistant between both speakers.
