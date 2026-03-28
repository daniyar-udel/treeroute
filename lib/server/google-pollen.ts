import type { LatLngLiteral, PollenSignal } from "@/lib/types";

function getPollenApiKey() {
  return process.env.GOOGLE_POLLEN_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
}

export async function getPollenSignal(point: LatLngLiteral): Promise<PollenSignal> {
  const apiKey = getPollenApiKey();

  if (!apiKey) {
    throw new Error("Missing Google Pollen API key.");
  }

  const url = new URL("https://pollen.googleapis.com/v1/forecast:lookup");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("days", "1");
  url.searchParams.set("location.latitude", String(point.lat));
  url.searchParams.set("location.longitude", String(point.lng));

  const response = await fetch(url.toString(), {
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    throw new Error(`Pollen API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    dailyInfo?: Array<{
      pollenTypeInfo?: Array<{
        code?: string;
        indexInfo?: {
          value?: number;
          category?: string;
        };
      }>;
    }>;
  };

  const pollenTypes = payload.dailyInfo?.[0]?.pollenTypeInfo ?? [];

  const lookup = (code: string) =>
    pollenTypes.find((entry) => entry.code === code)?.indexInfo?.value ?? 1;

  const treeIndex = lookup("TREE");
  const grassIndex = lookup("GRASS");
  const weedIndex = lookup("WEED");
  const maxIndex = Math.max(treeIndex, grassIndex, weedIndex);

  return {
    treeIndex,
    grassIndex,
    weedIndex,
    summary:
      maxIndex >= 4
        ? "Pollen pressure is elevated today, so route shape matters."
        : "Pollen conditions are moderate enough that local tree density drives most of the risk.",
  };
}
