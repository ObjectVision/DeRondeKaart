import type { LayerConfig, LayersFile, LayerFormat, StatisticConfig } from "./types";

// "geojson" is deliberately absent: it is an in-memory format (LayerConfig.data)
// constructed programmatically (e.g. by the Power BI bridge), never via layers.json.
const VALID_FORMATS: LayerFormat[] = ["geoarrow", "parquet", "mvt", "cog", "flatgeobuf", "composite"];

// Formats a "composite" entry may nest. "geojson" (in-memory) and "composite"
// itself (no nesting) are deliberately absent.
const CHILD_FORMATS: LayerFormat[] = ["geoarrow", "parquet", "mvt", "cog", "flatgeobuf"];

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

/** Zoom bound ("minzoom"/"maxzoom"): flatgeobuf fetch cutoff, composite child load range. */
function validateZoomBound(raw: unknown, id: string, key: "minzoom" | "maxzoom"): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 24) {
    console.warn(`layers.json: layer "${id}" has invalid "${key}" ${JSON.stringify(raw)}; ignoring`);
    return undefined;
  }
  return raw;
}

/** Validate one inline child of a "composite" entry. Returns null to drop the child. */
function validateChildConfig(
  raw: unknown,
  parent: { id: string; name: string; beforeid?: string },
  index: number,
): LayerConfig | null {
  const childId = `${parent.id}__c${index}`;
  if (typeof raw !== "object" || raw === null) {
    console.warn(`layers.json: composite "${parent.id}" child ${index} is not an object, skipping`);
    return null;
  }
  const child = raw as Record<string, unknown>;
  if (!child.source || typeof child.source !== "string") {
    console.warn(`layers.json: composite "${parent.id}" child ${index} missing "source", skipping`);
    return null;
  }
  if (!child.format || !CHILD_FORMATS.includes(child.format as LayerFormat)) {
    console.warn(
      `layers.json: composite "${parent.id}" child ${index} has invalid format "${child.format}", skipping`,
    );
    return null;
  }
  if (child.featureinfo !== undefined) {
    console.warn(
      `layers.json: composite "${parent.id}" child ${index} declares "featureinfo"; ` +
        "ignored — popups use the composite's own featureinfo",
    );
  }
  const minzoom = validateZoomBound(child.minzoom, childId, "minzoom");
  let maxzoom = validateZoomBound(child.maxzoom, childId, "maxzoom");
  if (minzoom !== undefined && maxzoom !== undefined && minzoom >= maxzoom) {
    console.warn(`layers.json: "${childId}" has minzoom >= maxzoom; ignoring maxzoom`);
    maxzoom = undefined;
  }
  return {
    id: childId,
    name: parent.name,
    source: child.source as string,
    format: child.format as LayerFormat,
    geometryType: (child.geometryType as LayerConfig["geometryType"]) ?? undefined,
    sourceLayer: (child.sourceLayer as string) ?? undefined,
    geostyler: (child.geostyler as LayerConfig["geostyler"]) ?? undefined,
    style: (child.style as LayerConfig["style"]) ?? {},
    beforeid: (child.beforeid as string) ?? parent.beforeid,
    embeddedColors: (child.embeddedColors as boolean) ?? undefined,
    minzoom,
    maxzoom,
  };
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
  if (!layer.format || !VALID_FORMATS.includes(layer.format as LayerFormat)) {
    console.warn(`layers.json: layer "${layer.id}" has invalid format "${layer.format}", skipping`);
    return null;
  }
  const isComposite = layer.format === "composite";
  // A composite has no source of its own — its children do.
  if (!isComposite && (!layer.source || typeof layer.source !== "string")) {
    console.warn(`layers.json: layer "${layer.id}" missing "source", skipping`);
    return null;
  }
  if ((layer.id as string).includes("__c")) {
    console.warn(
      `layers.json: layer id "${layer.id}" contains "__c" — reserved for composite child ids; ` +
        "this may break layer/config matching",
    );
  }

  let children: LayerConfig[] | undefined;
  if (isComposite) {
    if (!Array.isArray(layer.layers) || layer.layers.length === 0) {
      console.warn(`layers.json: composite "${layer.id}" has no "layers" array, skipping`);
      return null;
    }
    const parentMeta = {
      id: layer.id as string,
      name: layer.name as string,
      beforeid: (layer.beforeid as string) ?? undefined,
    };
    children = layer.layers
      .map((c, i) => validateChildConfig(c, parentMeta, i))
      .filter((c): c is LayerConfig => c !== null);
    if (children.length === 0) {
      console.warn(`layers.json: composite "${layer.id}" has no valid children, skipping`);
      return null;
    }
    if (layer.charts !== undefined || layer.statistics !== undefined) {
      console.warn(
        `layers.json: composite "${layer.id}" declares charts/statistics; ` +
          "ignored — composite layers are not chart eligible",
      );
    }
  }

  return {
    id: layer.id as string,
    name: layer.name as string,
    source: (layer.source as string) ?? "",
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
    minzoom: validateZoomBound(layer.minzoom, layer.id as string, "minzoom"),
    maxzoom: validateZoomBound(layer.maxzoom, layer.id as string, "maxzoom"),
    layers: children,
    embeddedColors: (layer.embeddedColors as boolean) ?? undefined,
    charts: isComposite ? undefined : validateCharts(layer.charts, layer.id as string),
    statistics: isComposite ? undefined : validateStatistics(layer.statistics, layer.id as string),
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
