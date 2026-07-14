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
  const tts = {
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  };
  const providers = {
    gemini: !!process.env.GEMINI_API_KEY,
    nvidia: !!process.env.NVIDIA_NIM_API_KEY,
  };
  return NextResponse.json({ ai, search, tts, providers });
}
