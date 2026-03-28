import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from "@google/genai";

import { scoreRoutes } from "@/lib/scoring";
import { midpoint } from "@/lib/utils";
import type {
  GoogleRoute,
  LatLngLiteral,
  RouteAnalysisRequest,
  RouteAnalysisResponse,
} from "@/lib/types";
import {
  buildFallbackRoutes,
  computeAlternativeWalkingRoutes,
  geocodeAddress,
} from "@/lib/server/google-maps";
import { getPollenSignal } from "@/lib/server/google-pollen";
import { getWeatherSignal } from "@/lib/server/google-weather";

const DEFAULT_WEATHER = { description: "Fallback", windSpeedMph: 8, humidity: 54, temperatureF: 61 };
const DEFAULT_POLLEN  = { treeIndex: 3, grassIndex: 1, weedIndex: 1, summary: "Fallback pollen" };

// ── Tool declarations ─────────────────────────────────────────────────────────

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "fetch_walking_routes",
    description: "Fetch 2-3 alternative walking routes between two NYC coordinates using Google Routes API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        origin_lat:      { type: Type.NUMBER, description: "Origin latitude" },
        origin_lng:      { type: Type.NUMBER, description: "Origin longitude" },
        destination_lat: { type: Type.NUMBER, description: "Destination latitude" },
        destination_lng: { type: Type.NUMBER, description: "Destination longitude" },
      },
      required: ["origin_lat", "origin_lng", "destination_lat", "destination_lng"],
    },
  },
  {
    name: "fetch_pollen_data",
    description: "Get current live tree, grass, and weed pollen indices at a NYC location via Google Pollen API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER, description: "Latitude" },
        lng: { type: Type.NUMBER, description: "Longitude" },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "fetch_weather_data",
    description: "Get current wind speed, humidity, and temperature at a NYC location via Google Weather API.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        lat: { type: Type.NUMBER, description: "Latitude" },
        lng: { type: Type.NUMBER, description: "Longitude" },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "score_route_exposure",
    description: "Score a walking route's pollen exposure using NYC Street Tree Census data, user allergy profile, pollen, and weather.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        route_id:          { type: Type.STRING },
        polyline:          { type: Type.STRING, description: "Google encoded polyline" },
        sensitivity:       { type: Type.STRING, description: "low | medium | high" },
        triggers:          { type: Type.ARRAY, items: { type: Type.STRING }, description: "Tree species triggers" },
        pollen_tree_index: { type: Type.NUMBER },
        wind_speed_mph:    { type: Type.NUMBER },
        humidity:          { type: Type.NUMBER },
      },
      required: ["route_id", "polyline", "sensitivity", "triggers", "pollen_tree_index", "wind_speed_mph", "humidity"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

interface ToolArgs { [key: string]: unknown }

async function executeTool(
  name: string,
  args: ToolArgs,
  state: AgentState,
): Promise<unknown> {
  switch (name) {
    case "fetch_walking_routes": {
      const origin      = { lat: args.origin_lat as number,      lng: args.origin_lng as number };
      const destination = { lat: args.destination_lat as number, lng: args.destination_lng as number };
      try {
        const routes = await computeAlternativeWalkingRoutes(origin, destination);
        state.routes = routes;
        return { routes: routes.map(r => ({ id: r.id, polyline: r.polyline, durationMin: r.durationMin, distanceMeters: r.distanceMeters })) };
      } catch {
        state.fallbackMode.push("fallback-routes");
        const routes = buildFallbackRoutes(origin, destination);
        state.routes = routes;
        return { routes: routes.map(r => ({ id: r.id, polyline: r.polyline, durationMin: r.durationMin, distanceMeters: r.distanceMeters })), fallback: true };
      }
    }

    case "fetch_pollen_data": {
      const point = { lat: args.lat as number, lng: args.lng as number };
      try {
        const pollen = await getPollenSignal(point);
        state.pollen = pollen;
        return pollen;
      } catch {
        state.fallbackMode.push("fallback-pollen");
        state.pollen = DEFAULT_POLLEN;
        return DEFAULT_POLLEN;
      }
    }

    case "fetch_weather_data": {
      const point = { lat: args.lat as number, lng: args.lng as number };
      try {
        const weather = await getWeatherSignal(point);
        state.weather = weather;
        return weather;
      } catch {
        state.fallbackMode.push("fallback-weather");
        state.weather = DEFAULT_WEATHER;
        return DEFAULT_WEATHER;
      }
    }

    case "score_route_exposure": {
      if (!state.routes.length || !state.pollen || !state.weather) {
        return { error: "Missing route/pollen/weather data. Call other tools first." };
      }
      const scored = scoreRoutes(state.routes, {
        sensitivity: args.sensitivity as "low" | "medium" | "high",
        triggers: args.triggers as string[],
        knowsTreeTriggers: (args.triggers as string[]).length > 0,
        name: "", email: "", registrationComplete: true,
      }, state.weather, state.pollen);
      state.scoredRoutes = scored;
      return scored.map(s => ({
        id: s.candidate.id,
        label: s.candidate.label,
        exposureScore: s.candidate.exposureScore,
        exposureLevel: s.candidate.exposureLevel,
        durationMin: s.candidate.durationMin,
        distanceMeters: s.candidate.distanceMeters,
        hotspots: s.candidate.hotspots,
        rationale: s.candidate.rationale,
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent state ───────────────────────────────────────────────────────────────

interface AgentState {
  routes: GoogleRoute[];
  pollen: typeof DEFAULT_POLLEN | null;
  weather: typeof DEFAULT_WEATHER | null;
  scoredRoutes: ReturnType<typeof scoreRoutes>;
  fallbackMode: string[];
}

// ── Main agent entry point ────────────────────────────────────────────────────

export async function runRouteAgent(
  request: RouteAnalysisRequest,
): Promise<RouteAnalysisResponse> {
  const apiKey = process.env.GOOGLE_AI_API_KEY ?? "";
  if (!apiKey) throw new Error("Missing GOOGLE_AI_API_KEY");

  // Geocode both waypoints
  const [origin, destination] = await Promise.all([
    request.origin.location
      ? Promise.resolve({ address: request.origin.address, location: request.origin.location })
      : geocodeAddress(request.origin.address),
    request.destination.location
      ? Promise.resolve({ address: request.destination.address, location: request.destination.location })
      : geocodeAddress(request.destination.address),
  ]);

  const center = midpoint([origin.location, destination.location]);
  const state: AgentState = { routes: [], pollen: null, weather: null, scoredRoutes: [], fallbackMode: [] };

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  const systemPrompt = `You are a pollen-aware walking route agent for NYC.
Your job: use the provided tools to analyse walking routes between two points and rank them by allergy exposure.

Steps you MUST follow in order:
1. Call fetch_walking_routes to get route alternatives
2. Call fetch_pollen_data and fetch_weather_data (you can call both, use the midpoint coordinates)
3. Call score_route_exposure once with the profile data to rank all routes
4. Return a JSON summary (no markdown, no code fences) with keys: summary, civicSummary, routeExplanations (object keyed by route id, each with explanation string max 45 words and rationale string array)

User profile: sensitivity=${request.profile.sensitivity}, triggers=${request.profile.triggers.join(",") || "general tree avoidance"}
Origin: ${origin.address} (${origin.location.lat}, ${origin.location.lng})
Destination: ${destination.address} (${destination.location.lat}, ${destination.location.lng})
Midpoint for pollen/weather: (${center.lat}, ${center.lng})`;

  // ── Agentic loop (max 8 turns) ────────────────────────────────────────────
  const contents: Content[] = [{ role: "user", parts: [{ text: systemPrompt }] }];
  let finalText = "";

  for (let turn = 0; turn < 8; turn++) {
    const response = await ai.models.generateContent({
      model,
      config: { tools: [{ functionDeclarations: TOOL_DECLARATIONS }] },
      contents,
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content) break;

    contents.push({ role: "model", parts: candidate.content.parts });

    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      finalText = response.text ?? "";
      break;
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      functionCalls.map(async (fc) => ({
        name: fc.name ?? "unknown",
        result: await executeTool(fc.name ?? "unknown", (fc.args ?? {}) as ToolArgs, state),
      }))
    );

    contents.push({
      role: "user",
      parts: toolResults.map((tr) => ({
        functionResponse: {
          name: tr.name,
          response: tr.result as Record<string, unknown>,
        },
      })),
    });
  }

  // ── Parse Gemini's final summary ──────────────────────────────────────────
  let summary = "";
  let civicSummary = "";
  let routeExplanations: Record<string, { explanation: string; rationale: string[] }> = {};

  try {
    const jsonStart = finalText.indexOf("{");
    const jsonEnd   = finalText.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(finalText.slice(jsonStart, jsonEnd + 1)) as {
        summary?: string;
        civicSummary?: string;
        routeExplanations?: Record<string, { explanation: string; rationale: string[] }>;
      };
      summary          = parsed.summary ?? "";
      civicSummary     = parsed.civicSummary ?? "";
      routeExplanations = parsed.routeExplanations ?? {};
    }
  } catch { /* use fallback text below */ }

  const routes = state.scoredRoutes.length
    ? state.scoredRoutes.map((s) => {
        const copy = routeExplanations[s.candidate.id];
        return {
          ...s.candidate,
          explanation: copy?.explanation || s.candidate.explanation,
          rationale:   copy?.rationale?.length ? copy.rationale : s.candidate.rationale,
        };
      })
    : [];

  const topArea  = state.scoredRoutes[0]?.dominantArea  ?? "Central Manhattan";
  const topLevel = state.scoredRoutes[0]?.dominantLevel ?? "moderate";
  const pollen  = state.pollen  ?? DEFAULT_POLLEN;
  const weather = state.weather ?? DEFAULT_WEATHER;

  if (!summary) {
    const best = routes[0];
    const target = request.profile.triggers.length ? request.profile.triggers.join(", ") : "overall tree contact";
    summary = best
      ? `${best.label} is the recommended route — lowest exposure to ${target} given today's pollen and wind conditions.`
      : "Route analysis complete.";
  }

  if (!civicSummary) {
    civicSummary = `${topArea} shows uneven allergy burden across NYC: tree density, local pollen pressure, and wind make nearby blocks feel very different for allergy-sensitive residents.`;
  }

  return {
    originResolved:      origin.address,
    destinationResolved: destination.address,
    originPoint:         origin.location,
    destinationPoint:    destination.location,
    summary,
    routingMode: request.profile.knowsTreeTriggers && request.profile.triggers.length
      ? "specific-tree-triggers"
      : "general-tree-avoidance",
    dataSources: [
      "Google Maps Routes API",
      "Google Pollen API",
      "Google Weather API",
      "Gemini Agent (ADK function calling)",
      "NYC 2015 Street Tree Census",
    ],
    routes,
    civicInsight: { areaName: topArea, treeBurdenLevel: topLevel, summary: civicSummary },
    weather,
    pollen,
    fallbackMode: state.fallbackMode,
  };
}
