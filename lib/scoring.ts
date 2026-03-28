import { SENSITIVITY_MULTIPLIERS, TRIGGER_ALIASES } from "@/lib/constants";
import { decodePolyline } from "@/lib/polyline";
import { lookupTreeCell } from "@/lib/tree-grid";
import type {
  ExposureLevel,
  GoogleRoute,
  PollenSignal,
  RouteCandidate,
  RouteHotspot,
  UserProfile,
  WeatherSignal,
} from "@/lib/types";
import { clamp, exposureLevelFromScore, round, sampleRoutePoints } from "@/lib/utils";

interface RouteScoreResult {
  candidate: RouteCandidate;
  dominantArea: string;
  dominantLevel: ExposureLevel;
}

export function scoreRoutes(
  routes: GoogleRoute[],
  profile: UserProfile,
  weather: WeatherSignal,
  pollen: PollenSignal,
): RouteScoreResult[] {
  return routes
    .map((route, index) => scoreSingleRoute(route, index, profile, weather, pollen))
    .sort((a, b) => a.candidate.exposureScore - b.candidate.exposureScore);
}

function scoreSingleRoute(
  route: GoogleRoute,
  index: number,
  profile: UserProfile,
  weather: WeatherSignal,
  pollen: PollenSignal,
): RouteScoreResult {
  const points = decodePolyline(route.polyline);
  const sampledPoints = sampleRoutePoints(points, 14);
  const sensitivity = SENSITIVITY_MULTIPLIERS[profile.sensitivity];
  const treeMatches = profile.knowsTreeTriggers ? profile.triggers : [];
  const generalAvoidanceMode = !profile.knowsTreeTriggers || !treeMatches.length;
  const routeTimeBoost = clamp(route.durationMin / 36, 0.7, 1.25);
  const pollenBoost = getTreePollenBoost(pollen);
  const weatherBoost = getWeatherBoost(weather);

  let aggregateBurden = 0;
  let peakBurden = 0;
  let dominantArea = "NYC corridor";
  let dominantRisk = 0;
  const hotspots: RouteHotspot[] = [];

  sampledPoints.forEach((point, pointIndex) => {
    const cell = lookupTreeCell(point);
    if (!cell) {
      return;
    }

    const speciesBoost = getSpeciesMatchBoost(treeMatches, cell.speciesWeights, cell.topSpecies, generalAvoidanceMode);
    const burden = cell.canopyScore * speciesBoost;
    aggregateBurden += burden;
    peakBurden = Math.max(peakBurden, burden);

    if (burden >= dominantRisk) {
      dominantRisk = burden;
      dominantArea = cell.areaName;
    }

    hotspots.push({
      lat: point.lat,
      lng: point.lng,
      label: `${cell.areaName} hotspot ${pointIndex + 1}`,
      risk: round(burden, 0),
    });
  });

  const normalizedBurden = sampledPoints.length ? aggregateBurden / sampledPoints.length : 18;
  const score = clamp(
    (normalizedBurden * 0.34 + peakBurden * 0.1 + pollenBoost * 5 + routeTimeBoost * 3) * sensitivity * weatherBoost,
    8,
    98,
  );

  const exposureLevel = exposureLevelFromScore(score);
  const candidate: RouteCandidate = {
    id: route.id,
    label: `Route ${String.fromCharCode(65 + index)}`,
    polyline: route.polyline,
    durationMin: route.durationMin,
    distanceMeters: route.distanceMeters,
    exposureScore: round(score, 0),
    exposureLevel,
    explanation: "",
    rationale: buildRationale(exposureLevel, profile, dominantArea, weather, pollen),
    hotspots: hotspots
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 3),
  };

  return {
    candidate,
    dominantArea,
    dominantLevel: exposureLevel,
  };
}

function getTreePollenBoost(pollen: PollenSignal) {
  return clamp(pollen.treeIndex + pollen.grassIndex * 0.12 + pollen.weedIndex * 0.08, 1, 5.5);
}

function getWeatherBoost(weather: WeatherSignal) {
  const windFactor = 1 + weather.windSpeedMph / 55;
  const humidityFactor = 1 - clamp((weather.humidity - 40) / 220, 0, 0.22);
  const temperatureFactor = weather.temperatureF >= 75 ? 1.05 : weather.temperatureF <= 45 ? 0.95 : 1;
  return clamp(windFactor * humidityFactor * temperatureFactor, 0.86, 1.34);
}

function getSpeciesMatchBoost(
  triggers: string[],
  speciesWeights: Record<string, number>,
  topSpecies: string[],
  generalAvoidanceMode: boolean,
) {
  if (generalAvoidanceMode) {
    const totalWeight = Object.values(speciesWeights).reduce((total, weight) => total + weight, 0);
    return clamp(0.95 + totalWeight * 0.55, 0.95, 1.55);
  }

  const matchedWeight = Object.entries(speciesWeights).reduce((total, [species, weight]) => {
    const isDirectTrigger = triggers.includes(species);
    const isAliasMatch = triggers.some((trigger) => {
      const aliases = TRIGGER_ALIASES[trigger] ?? [];
      return aliases.some((alias) => species.includes(alias));
    });

    return total + (isDirectTrigger || isAliasMatch ? weight : weight * 0.45);
  }, 0);

  const topSpeciesBoost = topSpecies.some((species) =>
    triggers.some((trigger) => species.toLowerCase().includes(trigger.toLowerCase())),
  )
    ? 0.3
    : 0;

  return clamp(0.9 + matchedWeight + topSpeciesBoost, 0.8, 2.1);
}

function buildRationale(
  level: ExposureLevel,
  profile: UserProfile,
  areaName: string,
  weather: WeatherSignal,
  pollen: PollenSignal,
) {
  const lines = [`${areaName} has elevated street-tree density relative to nearby blocks.`];

  if (profile.knowsTreeTriggers && profile.triggers.length) {
    lines.push(`This route is ranked against your selected tree triggers: ${profile.triggers.slice(0, 3).join(", ")}.`);
  } else {
    lines.push("No tree species were selected, so this route minimizes overall contact with trees.");
  }

  if (pollen.treeIndex >= 4 || weather.windSpeedMph >= 12) {
    lines.push(
      `Tree pollen is elevated and wind is around ${round(weather.windSpeedMph, 0)} mph, so spread risk is higher on exposed blocks.`,
    );
  } else if (level === "low") {
    lines.push("This route trades a bit of time for meaningfully lower tree-contact exposure.");
  } else {
    lines.push("This option keeps you closer to denser canopy pockets for more of the walk.");
  }

  return lines;
}
