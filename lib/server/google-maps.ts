import { encodePolyline } from "@/lib/polyline";
import type { GoogleRoute, LatLngLiteral, ResolvedWaypoint } from "@/lib/types";
import { distanceMeters, midpoint, round } from "@/lib/utils";

const MAPS_BASE_URL = "https://maps.googleapis.com";
const ROUTES_BASE_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DEMO_LOCATIONS: Record<string, LatLngLiteral> = {
  "washington square park": { lat: 40.7308, lng: -73.9973 },
  "lincoln center": { lat: 40.7725, lng: -73.9835 },
  "times square": { lat: 40.758, lng: -73.9855 },
  "grand central terminal": { lat: 40.7527, lng: -73.9772 },
  "bryant park": { lat: 40.7536, lng: -73.9832 },
  "union square": { lat: 40.7359, lng: -73.9911 },
  "columbus circle": { lat: 40.7681, lng: -73.9819 },
};

function getMapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
}

export function hasMapsApiKey() {
  return Boolean(getMapsApiKey());
}

export async function geocodeAddress(address: string): Promise<ResolvedWaypoint> {
  const apiKey = getMapsApiKey();
  const demoLocation = resolveDemoLocation(address);

  if (!apiKey) {
    if (demoLocation) {
      return demoLocation;
    }

    throw new Error("Missing GOOGLE_MAPS_API_KEY for geocoding.");
  }

  const url = new URL("/maps/api/geocode/json", MAPS_BASE_URL);
  url.searchParams.set("address", address);
  url.searchParams.set("components", "country:US|administrative_area:NY");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString(), {
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    throw new Error(`Geocoding failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  const result = payload.results?.[0];
  const location = result?.geometry?.location;

  if (!result || location?.lat == null || location.lng == null) {
    if (demoLocation) {
      return demoLocation;
    }

    throw new Error(`Unable to geocode address: ${address}`);
  }

  return {
    address: result.formatted_address ?? address,
    location: {
      lat: location.lat,
      lng: location.lng,
    },
  };
}

function resolveDemoLocation(address: string): ResolvedWaypoint | null {
  const normalized = address.trim().toLowerCase();

  const coordinateMatch = normalized.match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  );

  if (coordinateMatch) {
    return {
      address,
      location: {
        lat: Number(coordinateMatch[1]),
        lng: Number(coordinateMatch[2]),
      },
    };
  }

  const matchedEntry = Object.entries(DEMO_LOCATIONS).find(([key]) => normalized.includes(key));
  if (!matchedEntry) {
    return null;
  }

  return {
    address,
    location: matchedEntry[1],
  };
}

export async function computeAlternativeWalkingRoutes(
  origin: LatLngLiteral,
  destination: LatLngLiteral,
): Promise<GoogleRoute[]> {
  const apiKey = getMapsApiKey();

  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY for route computation.");
  }

  const response = await fetch(ROUTES_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: {
        location: {
          latLng: {
            latitude: origin.lat,
            longitude: origin.lng,
          },
        },
      },
      destination: {
        location: {
          latLng: {
            latitude: destination.lat,
            longitude: destination.lng,
          },
        },
      },
      travelMode: "WALK",
      computeAlternativeRoutes: true,
      polylineQuality: "HIGH_QUALITY",
      languageCode: "en-US",
      units: "IMPERIAL",
    }),
  });

  if (!response.ok) {
    throw new Error(`Routes API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    routes?: Array<{
      distanceMeters?: number;
      duration?: string;
      polyline?: { encodedPolyline?: string };
    }>;
  };

  const routes =
    payload.routes?.map((route, index) => ({
      id: `live-${index + 1}`,
      polyline: route.polyline?.encodedPolyline ?? "",
      durationMin: round(parseDurationMinutes(route.duration), 0),
      distanceMeters: route.distanceMeters ?? 0,
    })) ?? [];

  if (!routes.length || routes.every((route) => !route.polyline)) {
    throw new Error("Routes API returned no usable routes.");
  }

  return routes.slice(0, 3);
}

export function buildFallbackRoutes(origin: LatLngLiteral, destination: LatLngLiteral): GoogleRoute[] {
  const directDistance = distanceMeters(origin, destination);
  const baselineMinutes = Math.max(10, Math.round(directDistance / 72));
  const center = midpoint([origin, destination]);
  const deltaLat = destination.lat - origin.lat;
  const deltaLng = destination.lng - origin.lng;
  const perpendicular = normalizeVector({ lat: -deltaLng, lng: deltaLat });

  const offsets = [0, 0.0065, -0.0054];

  return offsets.map((offset, index) => {
    const viaPoint = {
      lat: center.lat + perpendicular.lat * offset,
      lng: center.lng + perpendicular.lng * offset,
    };

    const points =
      index === 0
        ? [origin, destination]
        : [
            origin,
            {
              lat: midpoint([origin, viaPoint]).lat + offset * 0.3,
              lng: midpoint([origin, viaPoint]).lng + offset * 0.14,
            },
            viaPoint,
            {
              lat: midpoint([viaPoint, destination]).lat - offset * 0.18,
              lng: midpoint([viaPoint, destination]).lng - offset * 0.1,
            },
            destination,
          ];

    const distanceMultiplier = index === 0 ? 1 : 1 + Math.abs(offset) * 12;

    return {
      id: `fallback-${index + 1}`,
      polyline: encodePolyline(points),
      durationMin: baselineMinutes + index * 3 + Math.round(distanceMultiplier * 2),
      distanceMeters: Math.round(directDistance * distanceMultiplier),
    };
  });
}

function parseDurationMinutes(duration: string | undefined) {
  if (!duration) {
    return 0;
  }

  const seconds = Number(duration.replace("s", ""));
  if (Number.isNaN(seconds)) {
    return 0;
  }

  return seconds / 60;
}

function normalizeVector(point: LatLngLiteral) {
  const length = Math.sqrt(point.lat ** 2 + point.lng ** 2);
  if (!length) {
    return { lat: 0.5, lng: 0.5 };
  }

  return {
    lat: point.lat / length,
    lng: point.lng / length,
  };
}
