import type { LayerConfig, LayersFile } from "./types";

let cachedConfig: LayerConfig[] | null = null;

export async function loadLayerConfigs(): Promise<LayerConfig[]> {
  if (cachedConfig) return cachedConfig;

  const response = await fetch("/layers.json");
  if (!response.ok) {
    throw new Error(`Failed to load layers.json: ${response.statusText}`);
  }

  const data: LayersFile = await response.json();
  cachedConfig = data.layers;
  return cachedConfig;
}

export function getLayerConfigById(
  configs: LayerConfig[],
  id: string,
): LayerConfig | undefined {
  return configs.find((c) => c.id === id);
}
