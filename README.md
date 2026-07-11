# ⚖️ Split — the AI debate referee

Place your phone between you and your debate opponent. Split listens to the
conversation and, in real time:

- **Fact-checks false claims and statistics** — when someone states something
  incorrect, a card pops up with the correct claim/statistic and an
  authoritative source.
- **Calls out logical fallacies** — ad hominem, straw man, false dilemma,
  whataboutism, slippery slope, and more, each with a one-line explanation of
  why it's a fallacy.

No alerts means the debate is clean. Better debates for both sides.

## How it works

1. The browser's built-in **Web Speech API** transcribes the debate live on
   your phone — no audio ever leaves the device.
2. Every few seconds, the new slice of transcript is sent to a serverless API
   route (`/api/analyze`).
3. The route asks **Google Gemini** (or **NVIDIA NIM**) — both have free
   tiers — to flag only clear-cut false claims and fallacies, and returns
   structured JSON.
4. Each flagged claim is then run through a **live web search** (Tavily,
   Brave Search, or the keyless Wikipedia API) so the cited source is a real,
   current result — not the model's memory.
5. New findings pop up as cards with a chime and vibration. A **Flip** button
   rotates the feed 180° so the person across the table can read it too.

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
higher-quality sources add one of:

| Variable | Free tier |
| --- | --- |
| `TAVILY_API_KEY` | 1,000 credits/month — [tavily.com](https://tavily.com) |
| `BRAVE_SEARCH_API_KEY` | 2,000 queries/month — [brave.com/search/api](https://brave.com/search/api) |

Tavily is preferred if both are set; anything that fails falls back down the
chain (Tavily → Brave → Wikipedia).

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

## Notes & limits

- The AI is prompted to be **conservative**: opinions, predictions, and
  hyperbole are never flagged — only concrete, checkable claims and clear-cut
  fallacies.
- Sources come from a live web search (authoritative domains are preferred
  when picking the result to cite); still, treat them as a starting point and
  verify anything that matters.
- Speech recognition quality depends on the device mic, distance, and
  crosstalk — put the phone roughly equidistant between both speakers.
