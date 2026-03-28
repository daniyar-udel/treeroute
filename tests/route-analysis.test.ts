import { encodePolyline } from "@/lib/polyline";
import { analyzeRouteRequest, type RouteAnalysisDependencies } from "@/lib/server/route-analysis";
import type { RouteAnalysisRequest } from "@/lib/types";

const request: RouteAnalysisRequest = {
  origin: {
    address: "Start",
    location: { lat: 40.74, lng: -73.984 },
  },
  destination: {
    address: "End",
    location: { lat: 40.788, lng: -73.984 },
  },
  profile: {
    triggers: ["oak"],
    sensitivity: "medium",
    knowsTreeTriggers: true,
  },
};

function buildDependencies(overrides: Partial<RouteAnalysisDependencies> = {}): RouteAnalysisDependencies {
  return {
    geocode: async (address) => ({
      address,
      location: { lat: 40.75, lng: -73.99 },
    }),
    routes: async () => [
      {
        id: "route-1",
        polyline: encodePolyline([
          { lat: 40.74, lng: -73.984 },
          { lat: 40.752, lng: -73.984 },
          { lat: 40.788, lng: -73.984 },
        ]),
        durationMin: 18,
        distanceMeters: 1800,
      },
      {
        id: "route-2",
        polyline: encodePolyline([
          { lat: 40.74, lng: -73.998 },
          { lat: 40.764, lng: -73.998 },
          { lat: 40.788, lng: -73.97 },
        ]),
        durationMin: 24,
        distanceMeters: 2400,
      },
    ],
    pollen: async () => ({
      treeIndex: 4,
      grassIndex: 1,
      weedIndex: 1,
      summary: "Elevated tree pollen",
    }),
    weather: async () => ({
      description: "Clear and breezy",
      windSpeedMph: 11,
      humidity: 48,
      temperatureF: 65,
    }),
    copy: async ({ routes, areaName }) => ({
      summary: `${routes[0]?.label} is safest today`,
      civicSummary: `${areaName} shows uneven canopy burden`,
      routeExplanations: Object.fromEntries(
        routes.map((route) => [
          route.id,
          {
            explanation: `${route.label} grounded explanation`,
            rationale: route.rationale,
          },
        ]),
      ),
    }),
    ...overrides,
  };
}

describe("analyzeRouteRequest", () => {
  it("returns ranked routes from live alternatives", async () => {
    const response = await analyzeRouteRequest(request, buildDependencies());

    expect(response.routes.length).toBeGreaterThanOrEqual(2);
    expect(response.routes[0]?.explanation).toContain("grounded explanation");
    expect(response.routingMode).toBe("specific-tree-triggers");
    expect(response.pollen.treeIndex).toBe(4);
  });

  it("supports general tree avoidance when the user does not know tree species", async () => {
    const response = await analyzeRouteRequest(
      {
        ...request,
        profile: {
          ...request.profile,
          triggers: [],
          knowsTreeTriggers: false,
        },
      },
      buildDependencies(),
    );

    expect(response.routes.length).toBeGreaterThan(0);
    expect(response.routingMode).toBe("general-tree-avoidance");
  });

  it("falls back to synthetic routes when the route provider fails", async () => {
    const response = await analyzeRouteRequest(
      request,
      buildDependencies({
        routes: async () => {
          throw new Error("no routes");
        },
      }),
    );

    expect(response.fallbackMode).toContain("fallback-routes");
    expect(response.routes.length).toBe(3);
  });

  it("degrades gracefully to fallback weather and pollen", async () => {
    const response = await analyzeRouteRequest(
      request,
      buildDependencies({
        pollen: async () => {
          throw new Error("no pollen");
        },
        weather: async () => {
          throw new Error("no weather");
        },
      }),
    );

    expect(response.fallbackMode).toContain("fallback-weather");
    expect(response.fallbackMode).toContain("fallback-pollen");
    expect(response.routes.length).toBeGreaterThan(0);
  });

});
