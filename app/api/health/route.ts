import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Lets the client verify setup on load instead of failing silently mid-debate. */
export async function GET() {
  const ai = process.env.GEMINI_API_KEY
    ? "gemini"
    : process.env.NVIDIA_NIM_API_KEY
      ? "nvidia-nim"
      : null;
  const search = process.env.TAVILY_API_KEY ? "tavily" : "wikipedia";
  return NextResponse.json({ ai, search });
}
