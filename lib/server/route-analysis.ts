import type {
  ExposureLevel,
  PollenSignal,
  ResolvedWaypoint,
  RouteAnalysisRequest,
  RouteAnalysisResponse,
  RouteCandidate,
  WeatherSignal,
} from "@/lib/types";
import { scoreRoutes } from "@/lib/scoring";
import { midpoint } from "@/lib/utils";
import {
  buildFallbackRoutes,
  computeAlternativeWalkingRoutes,
  geocodeAddress,
} from "@/lib/server/google-maps";
import { generateGroundedCopy } from "@/lib/server/gemini";
import { getPollenSignal } from "@/lib/server/google-pollen";
import { getWeatherSignal } from "@/lib/server/google-weather";

export interface RouteAnalysisDependencies {
  geocode: (address: string) => Promise<ResolvedWaypoint>;
  routes: typeof computeAlternativeWalkingRoutes;
  pollen: typeof getPollenSignal;
  weather: typeof getWeatherSignal;
  copy: typeof generateGroundedCopy;
}

const DEFAULT_WEATHER: WeatherSignal = {
  description: "Weather fallback active; using calm spring conditions.",
  windSpeedMph: 8,
  humidity: 54,
  temperatureF: 61,
};

const DEFAULT_POLLEN: PollenSignal = {
  treeIndex: 3,
  grassIndex: 1,
  weedIndex: 1,
  summary: "Live pollen unavailable; using tree-grid-weighted fallback.",
};

export const defaultDependencies: RouteAnalysisDependencies = {
  geocode: geocodeAddress,
  routes: computeAlternativeWalkingRoutes,
  pollen: getPollenSignal,
  weather: getWeatherSignal,
  copy: generateGroundedCopy,
};

export async function analyzeRouteRequest(
  request: RouteAnalysisRequest,
  dependencies: RouteAnalysisDependencies = defaultDependencies,
): Promise<RouteAnalysisResponse> {
  validateRequest(request);

  const origin = await resolveWaypoint(request.origin, dependencies);
  const destination = await resolveWaypoint(request.destination, dependencies);
  const centerPoint = midpoint([origin.location, destination.location]);
  const fallbackMode: string[] = [];

  const routes = await getRoutesWithFallback(origin, destination, dependencies, fallbackMode);
  const weather = await getWeatherWithFallback(centerPoint, dependencies, fallbackMode);
  const pollen = await getPollenWithFallback(centerPoint, dependencies, fallbackMode);
  const scoredRoutes = scoreRoutes(routes, request.profile, weather, pollen);
  const routingMode = request.profile.knowsTreeTriggers && request.profile.triggers.length
    ? "specific-tree-triggers"
    : "general-tree-avoidance";

  const topArea = scoredRoutes[0]?.dominantArea ?? "Central Manhattan";
  const topLevel = scoredRoutes[0]?.dominantLevel ?? "moderate";
  const copy = await dependencies.copy({
    profile: request.profile,
    routes: scoredRoutes.map((entry) => entry.candidate),
    weather,
    pollen,
    areaName: topArea,
    burdenLevel: topLevel,
    routingMode,
  });

  const enrichedRoutes = scoredRoutes.map((entry) => applyGeneratedCopy(entry.candidate, copy.routeExplanations));

  return {
    originResolved: origin.address,
    destinationResolved: destination.address,
    originPoint: origin.location,
    destinationPoint: destination.location,
    summary: copy.summary,
    routingMode,
    dataSources: [
      "Google Maps Routes API",
      "Google Maps JavaScript API",
      "Gemini via Google GenAI SDK",
      "NYC 2015 Street Tree Census",
    ],
    routes: enrichedRoutes,
    civicInsight: {
      areaName: topArea,
      treeBurdenLevel: topLevel,
      summary: copy.civicSummary,
    },
    weather,
    pollen,
    fallbackMode,
  };
}

async function resolveWaypoint(
  waypoint: RouteAnalysisRequest["origin"],
  dependencies: RouteAnalysisDependencies,
): Promise<ResolvedWaypoint> {
  if (waypoint.location) {
    return {
      address: waypoint.address || "Selected point",
      location: waypoint.location,
    };
  }

  return dependencies.geocode(waypoint.address);
}

async function getRoutesWithFallback(
  origin: ResolvedWaypoint,
  destination: ResolvedWaypoint,
  dependencies: RouteAnalysisDependencies,
  fallbackMode: string[],
) {
  try {
    const liveRoutes = await dependencies.routes(origin.location, destination.location);
    if (liveRoutes.length) {
      return liveRoutes;
    }
  } catch {
    fallbackMode.push("fallback-routes");
  }

  return buildFallbackRoutes(origin.location, destination.location);
}

async function getWeatherWithFallback(
  point: ResolvedWaypoint["location"],
  dependencies: RouteAnalysisDependencies,
  fallbackMode: string[],
) {
  try {
    return await dependencies.weather(point);
  } catch {
    fallbackMode.push("fallback-weather");
    return DEFAULT_WEATHER;
  }
}

async function getPollenWithFallback(
  point: ResolvedWaypoint["location"],
  dependencies: RouteAnalysisDependencies,
  fallbackMode: string[],
) {
  try {
    return await dependencies.pollen(point);
  } catch {
    fallbackMode.push("fallback-pollen");
    return DEFAULT_POLLEN;
  }
}

function applyGeneratedCopy(
  candidate: RouteCandidate,
  generated: Record<string, { explanation: string; rationale: string[] }>,
): RouteCandidate {
  const copy = generated[candidate.id];
  if (!copy) {
    return candidate;
  }

  return {
    ...candidate,
    explanation: copy.explanation,
    rationale: copy.rationale?.length ? copy.rationale : candidate.rationale,
  };
}

function validateRequest(request: RouteAnalysisRequest) {
  if (!request.origin?.address && !request.origin?.location) {
    throw new Error("Origin is required.");
  }

  if (!request.destination?.address && !request.destination?.location) {
    throw new Error("Destination is required.");
  }

  if (request.profile.knowsTreeTriggers && !request.profile?.triggers?.length) {
    throw new Error("Choose at least one tree trigger or switch to general tree avoidance.");
  }
}
