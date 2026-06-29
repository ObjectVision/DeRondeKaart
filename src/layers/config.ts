import type { LayerConfig, LayersFile, LayerFormat } from "./types";

const VALID_FORMATS: LayerFormat[] = ["geoarrow", "geoparquet", "parquet", "mvt", "cog"];

let cachedConfig: LayerConfig[] | null = null;

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
    embeddedColors: (layer.embeddedColors as boolean) ?? undefined,
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
