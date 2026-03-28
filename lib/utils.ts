import type { ExposureLevel, LatLngLiteral } from "@/lib/types";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, precision = 1) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function midpoint(points: LatLngLiteral[]): LatLngLiteral {
  if (!points.length) {
    return { lat: 40.758, lng: -73.9855 };
  }

  const sum = points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat,
      lng: acc.lng + point.lng,
    }),
    { lat: 0, lng: 0 },
  );

  return {
    lat: sum.lat / points.length,
    lng: sum.lng / points.length,
  };
}

export function distanceMeters(a: LatLngLiteral, b: LatLngLiteral) {
  const earthRadius = 6_371_000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLng = ((b.lng - a.lng) * Math.PI) / 180;

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadius * arc;
}

export function sampleRoutePoints(points: LatLngLiteral[], samples = 12): LatLngLiteral[] {
  if (points.length <= samples) {
    return points;
  }

  const bucket = (points.length - 1) / (samples - 1);
  return Array.from({ length: samples }, (_, index) => points[Math.round(index * bucket)]);
}

export function exposureLevelFromScore(score: number): ExposureLevel {
  if (score < 32) {
    return "low";
  }

  if (score < 62) {
    return "moderate";
  }

  return "high";
}
