import type { LatLngLiteral, WeatherSignal } from "@/lib/types";

function getWeatherApiKey() {
  return process.env.GOOGLE_WEATHER_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
}

export async function getWeatherSignal(point: LatLngLiteral): Promise<WeatherSignal> {
  const apiKey = getWeatherApiKey();

  if (!apiKey) {
    throw new Error("Missing Google Weather API key.");
  }

  const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("unitsSystem", "IMPERIAL");
  url.searchParams.set("location.latitude", String(point.lat));
  url.searchParams.set("location.longitude", String(point.lng));

  const response = await fetch(url.toString(), {
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    throw new Error(`Weather API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    weatherCondition?: { description?: { text?: string } };
    temperature?: { degrees?: number };
    relativeHumidity?: number;
    wind?: { speed?: { value?: number; unit?: string } };
  };

  const windValue = payload.wind?.speed?.value ?? 7;
  const windUnit = payload.wind?.speed?.unit ?? "MILES_PER_HOUR";
  const windSpeedMph = windUnit === "KILOMETERS_PER_HOUR" ? windValue * 0.621371 : windValue;

  return {
    description: payload.weatherCondition?.description?.text ?? "Current neighborhood conditions loaded",
    windSpeedMph,
    humidity: payload.relativeHumidity ?? 58,
    temperatureF: payload.temperature?.degrees ?? 63,
  };
}
