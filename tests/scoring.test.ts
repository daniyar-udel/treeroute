import { encodePolyline } from "@/lib/polyline";
import { scoreRoutes } from "@/lib/scoring";
import type { GoogleRoute, PollenSignal, UserProfile, WeatherSignal } from "@/lib/types";

const weather: WeatherSignal = {
  description: "Breezy and dry",
  windSpeedMph: 12,
  humidity: 46,
  temperatureF: 66,
};

const pollen: PollenSignal = {
  treeIndex: 4,
  grassIndex: 1,
  weedIndex: 1,
  summary: "Tree pollen elevated",
};

function buildRoute(id: string, points: Array<{ lat: number; lng: number }>, durationMin: number, distanceMeters: number): GoogleRoute {
  return {
    id,
    polyline: encodePolyline(points),
    durationMin,
    distanceMeters,
  };
}

describe("scoreRoutes", () => {
  it("increases exposure when trigger overlap is stronger", () => {
    const route = buildRoute(
      "r1",
      [
        { lat: 40.772, lng: -73.985 },
        { lat: 40.788, lng: -73.983 },
      ],
      18,
      1800,
    );

    const mildProfile: UserProfile = {
      triggers: [],
      sensitivity: "medium",
      knowsTreeTriggers: false,
    };

    const treeProfile: UserProfile = {
      triggers: ["oak"],
      sensitivity: "medium",
      knowsTreeTriggers: true,
    };

    const mildScore = scoreRoutes([route], mildProfile, weather, pollen)[0]?.candidate.exposureScore ?? 0;
    const treeScore = scoreRoutes([route], treeProfile, weather, pollen)[0]?.candidate.exposureScore ?? 0;

    expect(treeScore).toBeGreaterThan(mildScore);
  });

  it("can rank a longer lower-burden route above a shorter higher-burden route", () => {
    const riskyRoute = buildRoute(
      "risky",
      [
        { lat: 40.776, lng: -73.985 },
        { lat: 40.789, lng: -73.984 },
      ],
      15,
      1500,
    );

    const saferRoute = buildRoute(
      "safer",
      [
        { lat: 40.752, lng: -73.998 },
        { lat: 40.764, lng: -73.97 },
      ],
      22,
      2500,
    );

    const profile: UserProfile = {
      triggers: ["oak"],
      sensitivity: "medium",
      knowsTreeTriggers: true,
    };

    const [best] = scoreRoutes([riskyRoute, saferRoute], profile, weather, pollen);
    expect(best?.candidate.id).toBe("safer");
  });

  it("raises scores for highly sensitive users", () => {
    const route = buildRoute(
      "r1",
      [
        { lat: 40.74, lng: -73.984 },
        { lat: 40.752, lng: -73.97 },
      ],
      16,
      1600,
    );

    const lowSensitivity: UserProfile = {
      triggers: ["maple"],
      sensitivity: "low",
      knowsTreeTriggers: true,
    };

    const highSensitivity: UserProfile = {
      triggers: ["maple"],
      sensitivity: "high",
      knowsTreeTriggers: true,
    };

    const lowScore = scoreRoutes([route], lowSensitivity, weather, pollen)[0]?.candidate.exposureScore ?? 0;
    const highScore = scoreRoutes([route], highSensitivity, weather, pollen)[0]?.candidate.exposureScore ?? 0;

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("minimizes overall tree contact when the user does not know specific tree triggers", () => {
    const route = buildRoute(
      "r1",
      [
        { lat: 40.752, lng: -73.984 },
        { lat: 40.776, lng: -73.97 },
      ],
      20,
      2100,
    );

    const profile: UserProfile = {
      triggers: [],
      sensitivity: "medium",
      knowsTreeTriggers: false,
    };

    const generalScore = scoreRoutes([route], profile, weather, pollen)[0]?.candidate.exposureScore ?? 0;
    expect(generalScore).toBeGreaterThan(0);
  });

  it("raises exposure when pollen and wind conditions intensify", () => {
    const route = buildRoute(
      "r1",
      [
        { lat: 40.752, lng: -73.984 },
        { lat: 40.776, lng: -73.97 },
      ],
      20,
      2100,
    );

    const profile: UserProfile = {
      triggers: [],
      sensitivity: "medium",
      knowsTreeTriggers: false,
    };

    const calmScore =
      scoreRoutes(
        [route],
        profile,
        { ...weather, windSpeedMph: 4, humidity: 68, temperatureF: 56 },
        { ...pollen, treeIndex: 2 },
      )[0]?.candidate.exposureScore ?? 0;
    const intenseScore =
      scoreRoutes(
        [route],
        profile,
        { ...weather, windSpeedMph: 18, humidity: 32, temperatureF: 74 },
        { ...pollen, treeIndex: 5 },
      )[0]?.candidate.exposureScore ?? 0;

    expect(intenseScore).toBeGreaterThan(calmScore);
  });
});
