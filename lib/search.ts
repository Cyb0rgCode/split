export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 4000;

/* Domains treated as more authoritative when picking a source to cite. */
const PREFERRED_DOMAINS =
  /\.(gov|edu|int)([/:]|$)|who\.int|un\.org|oecd\.org|worldbank\.org|imf\.org|europa\.eu|nature\.com|science\.org|britannica\.com|reuters\.com|apnews\.com|pewresearch\.org|ourworldindata\.org|wikipedia\.org/i;

async function searchTavily(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}`);
  const data = await res.json();
  return (data?.results ?? [])
    .filter((r: { url?: string }) => typeof r?.url === "string")
    .map((r: { title?: string; url: string; content?: string }) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.content ?? "",
    }));
}

/* Keyless fallback so search works with zero configuration. */
async function searchWikipedia(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=${encodeURIComponent(query)}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Wikipedia search error ${res.status}`);
  const data = await res.json();
  return (data?.pages ?? [])
    .filter((p: { key?: string }) => typeof p?.key === "string")
    .map((p: { title?: string; key: string; excerpt?: string }) => ({
      title: p.title ? `Wikipedia: ${p.title}` : "Wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
      snippet: (p.excerpt ?? "").replace(/<[^>]+>/g, ""),
    }));
}

/**
 * Search the web with whichever provider is configured, in order of quality:
 * Tavily → Wikipedia (keyless). Returns null if everything fails — callers
 * should fall back gracefully rather than block the debate.
 */
export async function searchWeb(query: string): Promise<SearchResult[] | null> {
  const providers: Array<() => Promise<SearchResult[]>> = [];
  if (process.env.TAVILY_API_KEY) providers.push(() => searchTavily(query));
  providers.push(() => searchWikipedia(query));

  for (const provider of providers) {
    try {
      const results = await provider();
      if (results.length > 0) return results;
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

/** Pick the most citable result, preferring authoritative domains. */
export function pickBestResult(results: SearchResult[]): SearchResult {
  return results.find((r) => PREFERRED_DOMAINS.test(r.url)) ?? results[0];
}
