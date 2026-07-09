import type { LayerConfig, LayersFile, LayerFormat, StatisticConfig } from "./types";

// "geojson" is deliberately absent: it is an in-memory format (LayerConfig.data)
// constructed programmatically (e.g. by the Power BI bridge), never via layers.json.
const VALID_FORMATS: LayerFormat[] = ["geoarrow", "geoparquet", "parquet", "mvt", "cog"];

let cachedConfig: LayerConfig[] | null = null;

/** Ids of charts.json definitions; the analytics panel uses at most 4. */
function validateCharts(raw: unknown, id: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && c !== "")) {
    console.warn(`layers.json: layer "${id}" has invalid "charts"; ignoring`);
    return undefined;
  }
  if (raw.length > 4) {
    console.warn(`layers.json: layer "${id}" lists ${raw.length} charts; only the first 4 are shown`);
    return raw.slice(0, 4);
  }
  return raw;
}

const VALID_STATS: StatisticConfig["stat"][] = ["sum", "count", "mean", "variance"];

function validateStatistics(raw: unknown, id: string): StatisticConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`layers.json: layer "${id}" has invalid "statistics"; ignoring`);
    return undefined;
  }
  const valid = raw.filter((entry): entry is StatisticConfig => {
    const ok =
      typeof entry === "object" && entry !== null &&
      typeof entry.field === "string" && entry.field !== "" &&
      VALID_STATS.includes(entry.stat) &&
      typeof entry.label === "string" &&
      typeof entry.icon === "string";
    if (!ok) {
      console.warn(`layers.json: layer "${id}" dropping invalid statistic ${JSON.stringify(entry)}`);
    }
    return ok;
  });
  return valid.length > 0 ? valid : undefined;
}

function validateLayerConfig(layer: Record<string, unknown>, index: number): LayerConfig | null {
  if (!layer.id || typeof layer.id !== "string") {
    console.warn(`layers.json: entry ${index} missing "id", skipping`);
    return null;
  }
  if (!layer.name || typeof layer.name !== "string") {
    console.warn(`layers.json: layer "${layer.id}" missing "name", skipping`);
    return null;
  }
  if (!layer.source || typeof layer.source !== "string") {
    console.warn(`layers.json: layer "${layer.id}" missing "source", skipping`);
    return null;
  }
  if (!layer.format || !VALID_FORMATS.includes(layer.format as LayerFormat)) {
    console.warn(`layers.json: layer "${layer.id}" has invalid format "${layer.format}", skipping`);
    return null;
  }
  return {
    id: layer.id as string,
    name: layer.name as string,
    source: layer.source as string,
    format: layer.format as LayerFormat,
    geometryType: (layer.geometryType as LayerConfig["geometryType"]) ?? undefined,
    sourceLayer: (layer.sourceLayer as string) ?? undefined,
    geostyler: (layer.geostyler as LayerConfig["geostyler"]) ?? undefined,
    style: (layer.style as LayerConfig["style"]) ?? {},
    featureinfo: (layer.featureinfo as LayerConfig["featureinfo"]) ?? undefined,
    excludeFromLegend: (layer.excludeFromLegend as boolean) ?? undefined,
    excludeFromPicking: (layer.excludeFromPicking as boolean) ?? undefined,
    excludeFromComparison: (layer.excludeFromComparison as boolean) ?? undefined,
    beforeid: (layer.beforeid as string) ?? undefined,
    embeddedColors: (layer.embeddedColors as boolean) ?? undefined,
    charts: validateCharts(layer.charts, layer.id as string),
    statistics: validateStatistics(layer.statistics, layer.id as string),
  };
}

export async function loadLayerConfigs(): Promise<LayerConfig[]> {
  if (cachedConfig) return cachedConfig;

  const response = await fetch("/layers.json");
  if (!response.ok) {
    throw new Error(`Failed to load layers.json: ${response.statusText}`);
  }

  const data: LayersFile = await response.json();

  if (!data.layers || !Array.isArray(data.layers)) {
    console.warn("layers.json: missing or invalid \"layers\" array");
    cachedConfig = [];
    return cachedConfig;
  }

  cachedConfig = data.layers
    .map((l, i) => validateLayerConfig(l as unknown as Record<string, unknown>, i))
    .filter((l): l is LayerConfig => l !== null);

  return cachedConfig;
}

export function getLayerConfigById(
  configs: LayerConfig[],
  id: string,
): LayerConfig | undefined {
  return configs.find((c) => c.id === id);
}
