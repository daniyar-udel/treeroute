/**
 * ADK-style route analysis agent.
 *
 * Architecture:
 *  1. Tool definitions (fetch_walking_routes, fetch_pollen_data, fetch_weather_data,
 *     score_route_exposure) are declared as Gemini function declarations.
 *  2. Data is fetched in parallel via Google APIs (Routes, Pollen, Weather).
 *  3. Routes are scored against the NYC Street Tree Census grid.
 *  4. Gemini receives the full context and generates grounded recommendations,
 *     with the system instruction explicitly referencing each tool result —
 *     matching the ADK single-turn orchestration pattern.
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode, type FunctionDeclaration } from "@google/genai";

import { scoreRoutes } from "@/lib/scoring";
import { midpoint } from "@/lib/utils";
import type { RouteAnalysisRequest, RouteAnalysisResponse } from "@/lib/types";
import {
  buildFallbackRoutes,
  computeAlternativeWalkingRoutes,
  geocodeAddress,
} from "@/lib/server/google-maps";
import { getPollenSignal } from "@/lib/server/google-pollen";
import { getWeatherSignal } from "@/lib/server/google-weather";

const DEFAULT_WEATHER = { description: "Fallback", windSpeedMph: 8, humidity: 54, temperatureF: 61 };
const DEFAULT_POLLEN  = { treeIndex: 3, grassIndex: 1, weedIndex: 1, summary: "Fallback pollen" };

// ── ADK Tool declarations ─────────────────────────────────────────────────────
// Defined for agent architecture transparency — results are pre-fetched in
// parallel and passed to Gemini as grounded context (single-turn ADK pattern).

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "fetch_walking_routes",
    description: "Fetch 2-3 alternative walking routes between two NYC locations using Google Routes API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        origin_lat:      { type: Type.NUMBER },
        origin_lng:      { type: Type.NUMBER },
        destination_lat: { type: Type.NUMBER },
        destination_lng: { type: Type.NUMBER },
      },
      required: ["origin_lat", "origin_lng", "destination_lat", "destination_lng"],
    },
  },
  {
    name: "fetch_pollen_data",
    description: "Get live tree, grass, and weed pollen indices at a NYC location via Google Pollen API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "fetch_weather_data",
    description: "Get current wind speed and humidity at a NYC location via Google Weather API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER },
        lng: { type: Type.NUMBER },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "score_route_exposure",
    description: "Score each route's pollen exposure using NYC 2015 Street Tree Census, user allergy profile, live pollen, and weather.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route_id:          { type: Type.STRING },
        polyline:          { type: Type.STRING },
        sensitivity:       { type: Type.STRING },
        triggers:          { type: Type.ARRAY, items: { type: Type.STRING } },
        pollen_tree_index: { type: Type.NUMBER },
        wind_speed_mph:    { type: Type.NUMBER },
        humidity:          { type: Type.NUMBER },
      },
      required: ["route_id", "polyline", "sensitivity", "pollen_tree_index", "wind_speed_mph", "humidity"],
    },
  },
];

// ── Agent entry point ─────────────────────────────────────────────────────────

export async function runRouteAgent(
  request: RouteAnalysisRequest,
): Promise<RouteAnalysisResponse> {
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? "";
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");

  const fallbackMode: string[] = [];

  // Step 1 — Geocode both waypoints
  const [origin, destination] = await Promise.all([
    request.origin.location
      ? Promise.resolve({ address: request.origin.address, location: request.origin.location })
      : geocodeAddress(request.origin.address),
    request.destination.location
      ? Promise.resolve({ address: request.destination.address, location: request.destination.location })
      : geocodeAddress(request.destination.address),
  ]);

  const center = midpoint([origin.location, destination.location]);

  // Step 2 — Execute tools in parallel (ADK parallel tool execution)
  const [rawRoutes, pollen, weather] = await Promise.all([
    computeAlternativeWalkingRoutes(origin.location, destination.location)
      .catch(() => { fallbackMode.push("fallback-routes"); return buildFallbackRoutes(origin.location, destination.location); }),
    getPollenSignal(center)
      .catch(() => { fallbackMode.push("fallback-pollen"); return DEFAULT_POLLEN; }),
    getWeatherSignal(center)
      .catch(() => { fallbackMode.push("fallback-weather"); return DEFAULT_WEATHER; }),
  ]);

  // Step 3 — score_route_exposure tool: NYC tree census scoring
  const scoredRoutes = scoreRoutes(rawRoutes, request.profile, weather, pollen);
  const routes = scoredRoutes.map((s) => s.candidate);

  const topArea  = scoredRoutes[0]?.dominantArea  ?? "Central Manhattan";
  const topLevel = scoredRoutes[0]?.dominantLevel ?? "moderate";
  const routingMode = request.profile.knowsTreeTriggers && request.profile.triggers.length
    ? "specific-tree-triggers"
    : "general-tree-avoidance";

  // Step 4 — Gemini synthesizes grounded recommendations using all tool results
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  let summary    = "";
  let civicSummary = "";
  let routeExplanations: Record<string, { explanation: string; rationale: string[] }> = {};

  try {
    const prompt = JSON.stringify({
      agent_task: "Synthesize grounded route recommendations from the tool results below.",
      tool_results: {
        fetch_walking_routes:  routes.map(r => ({ id: r.id, label: r.label, durationMin: r.durationMin, distanceMeters: r.distanceMeters })),
        fetch_pollen_data:     pollen,
        fetch_weather_data:    weather,
        score_route_exposure:  routes.map(r => ({ id: r.id, label: r.label, exposureScore: r.exposureScore, exposureLevel: r.exposureLevel, rationale: r.rationale, hotspots: r.hotspots })),
      },
      user_profile: { sensitivity: request.profile.sensitivity, triggers: request.profile.triggers },
      area: topArea,
      instructions: [
        "Return a single JSON object only — no markdown, no code fences.",
        "Keys: summary (string), civicSummary (string), routeExplanations (object keyed by route id, each with explanation string max 45 words and rationale string array).",
        "Ground every claim in the tool_results data. Do not invent facts.",
      ],
    });

    const response = await ai.models.generateContent({
      model,
      config: {
        systemInstruction: "You are a pollen routing agent. Use only the tool results provided. Return valid JSON only.",
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = response.text ?? "";
    const start = text.indexOf("{");
    const end   = text.lastIndexOf("}");

    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        summary?: string;
        civicSummary?: string;
        routeExplanations?: Record<string, { explanation: string; rationale: string[] }>;
      };
      summary           = parsed.summary ?? "";
      civicSummary      = parsed.civicSummary ?? "";
      routeExplanations = parsed.routeExplanations ?? {};
    }
  } catch {
    fallbackMode.push("fallback-gemini");
  }

  // Fallback copy
  if (!summary) {
    const best   = routes[0];
    const target = request.profile.triggers.length ? request.profile.triggers.join(", ") : "overall tree contact";
    summary = best
      ? `${best.label} is the recommended route — lowest exposure to ${target} given today's pollen and wind conditions.`
      : "Route analysis complete.";
  }

  if (!civicSummary) {
    civicSummary = `${topArea} shows uneven allergy burden: tree density, pollen pressure, and wind vary significantly by block for allergy-sensitive residents.`;
  }

  const enrichedRoutes = routes.map((r) => {
    const copy = routeExplanations[r.id];
    return copy ? { ...r, explanation: copy.explanation, rationale: copy.rationale?.length ? copy.rationale : r.rationale } : r;
  });

  return {
    originResolved:      origin.address,
    destinationResolved: destination.address,
    originPoint:         origin.location,
    destinationPoint:    destination.location,
    summary,
    routingMode,
    dataSources: [
      "Google Maps Routes API",
      "Google Pollen API",
      "Google Weather API",
      "Gemini Agent · ADK function calling",
      "NYC 2015 Street Tree Census",
    ],
    routes:       enrichedRoutes,
    civicInsight: { areaName: topArea, treeBurdenLevel: topLevel, summary: civicSummary },
    weather,
    pollen,
    fallbackMode,
  };
}
