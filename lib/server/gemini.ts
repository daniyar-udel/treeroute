import { GoogleGenAI } from "@google/genai";

import type { ExposureLevel, PollenSignal, RouteCandidate, RoutingMode, UserProfile, WeatherSignal } from "@/lib/types";

interface CopyInput {
  profile: UserProfile;
  routes: RouteCandidate[];
  weather: WeatherSignal;
  pollen: PollenSignal;
  areaName: string;
  burdenLevel: ExposureLevel;
  routingMode: RoutingMode;
}

interface GeneratedCopy {
  summary: string;
  civicSummary: string;
  routeExplanations: Record<string, { explanation: string; rationale: string[] }>;
}

function getGeminiApiKey() {
  return process.env.GOOGLE_AI_API_KEY ?? "";
}

export async function generateGroundedCopy(input: CopyInput): Promise<GeneratedCopy> {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    return buildFallbackCopy(input);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      config: {
        systemInstruction:
          "You are a routing assistant. Always respond with a single valid JSON object — no markdown, no code fences, no extra text. The JSON must have exactly these top-level keys: summary (string), civicSummary (string), routeExplanations (object keyed by route id, each with explanation string and rationale string array). Keep each explanation under 45 words. Use only data provided. Do not invent facts.",
      },
      contents: [
        JSON.stringify({
          task: "Generate grounded route copy from the analysis payload below.",
          payload: input,
        }),
      ],
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(extractJsonObject(text)) as GeneratedCopy;

    if (!parsed.summary || !parsed.civicSummary) {
      return buildFallbackCopy(input);
    }

    return parsed;
  } catch {
    return buildFallbackCopy(input);
  }
}

function buildFallbackCopy(input: CopyInput): GeneratedCopy {
  const best = input.routes[0];
  const targetLabel =
    input.routingMode === "specific-tree-triggers" && input.profile.triggers.length
      ? input.profile.triggers.join(", ")
      : "overall street-tree contact";
  const routeExplanations = Object.fromEntries(
    input.routes.map((route, index) => [
      route.id,
      {
        explanation:
          index === 0
            ? `${route.label} is the safest tradeoff today because it avoids the densest tree pockets while keeping walking time realistic.`
            : `${route.label} keeps you closer to denser tree-lined blocks, so its tree-contact burden is higher today.`,
        rationale: route.rationale,
      },
    ]),
  );

  return {
    summary: `${best.label} is the recommended route because it lowers likely exposure to ${targetLabel} while accounting for today's tree pollen and wind conditions.`,
    civicSummary: `${input.areaName} shows why allergy burden is uneven across NYC: tree density, local pollen pressure, and wind make nearby blocks feel very different for residents trying to limit exposure.`,
    routeExplanations,
  };
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain JSON.");
  }

  return text.slice(start, end + 1);
}
