import { NextRequest, NextResponse } from "next/server";
import { pickBestResult, searchWeb } from "@/lib/search";

export const maxDuration = 10;

/**
 * Background source lookup. The analyze route no longer blocks on web
 * search — the client calls this after the callout is already speaking
 * and swaps the citation in when a live result lands.
 */
export async function POST(req: NextRequest) {
  let query = "";
  try {
    const body = await req.json();
    query = typeof body.query === "string" ? body.query.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!query) return NextResponse.json({ error: "Missing 'query'" }, { status: 400 });

  const results = await searchWeb(query.slice(0, 200));
  if (!results || results.length === 0) {
    return NextResponse.json({ error: "No results" }, { status: 404 });
  }
  const best = pickBestResult(results);
  return NextResponse.json({
    source_name: best.title.slice(0, 120),
    source_url: best.url,
  });
}
