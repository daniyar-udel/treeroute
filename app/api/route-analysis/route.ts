import { NextResponse } from "next/server";

import { runRouteAgent } from "@/lib/server/agent";
import { analyzeRouteRequest } from "@/lib/server/route-analysis";
import type { RouteAnalysisRequest } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RouteAnalysisRequest;

    // Use ADK agent when Gemini API key is available, fallback to direct pipeline
    const result = process.env.GOOGLE_AI_API_KEY
      ? await runRouteAgent(body)
      : await analyzeRouteRequest(body);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze routes right now.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
