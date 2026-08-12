import type { LayerConfig, LayersFile, LayerFormat, StatisticConfig, TimeseriesConfig } from "./types";

// "geojson" is deliberately absent: it is an in-memory format (LayerConfig.data)
// constructed programmatically (e.g. by the Power BI bridge), never via layers.json.
const VALID_FORMATS: LayerFormat[] = ["mvt", "cog", "flatgeobuf", "pmtiles", "composite"];

// Formats a "composite" entry may nest. "geojson" (in-memory) and "composite"
// itself (no nesting) are deliberately absent.
const CHILD_FORMATS: LayerFormat[] = ["mvt", "cog", "flatgeobuf", "pmtiles"];

let cachedConfig: LayerConfig[] | null = null;

/** Sidecar table URL for the analytics panel (see LayerConfig.attributeSource). */
function validateAttributeSource(raw: unknown, id: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw === "") {
    console.warn(`layers.json: layer "${id}" has invalid "attributeSource"; ignoring`);
    return undefined;
  }
  return raw;
}

/** Path to an HTML fragment describing the dataset (see LayerConfig.meta). */
function validateMeta(raw: unknown, id: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw === "") {
    console.warn(`layers.json: layer "${id}" has invalid "meta"; ignoring`);
    return undefined;
  }
  return raw;
}

/** Brief plain-text summary of the layer (see LayerConfig.description). */
function validateDescription(raw: unknown, id: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw === "") {
    console.warn(`layers.json: layer "${id}" has invalid "description"; ignoring`);
    return undefined;
  }
  return raw;
}

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

const DEFAULT_TIMESERIES_PLACEHOLDER = "%YEAR%";
const DEFAULT_TIMESERIES_INTERVAL_MS = 1000;

/**
 * Timeseries playback block. Dropped (with a warning) rather than half-applied:
 * a layer whose `sourceLayer` lacks the placeholder would step through years
 * without the rendered layer ever changing, which is a confusing silent no-op.
 */
function validateTimeseries(
  raw: unknown,
  id: string,
  sourceLayer: string | undefined,
): TimeseriesConfig | undefined {
  if (raw === undefined) return undefined;

  const drop = (why: string) => {
    console.warn(`layers.json: layer "${id}" has invalid "timeseries" (${why}); ignoring`);
    return undefined;
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return drop("not an object");
  }

  const ts = raw as Record<string, unknown>;
  const num = (key: "start" | "end" | "step" | "intervalMs") => {
    const value = ts[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const start = num("start");
  const end = num("end");
  const step = num("step");
  if (start === undefined) return drop('"start" must be a finite number');
  if (end === undefined) return drop('"end" must be a finite number');
  if (step === undefined || step <= 0) return drop('"step" must be a number > 0');
  if (end < start) return drop(`"end" ${end} is before "start" ${start}`);

  const placeholder =
    typeof ts.placeholder === "string" && ts.placeholder.length > 0
      ? ts.placeholder
      : DEFAULT_TIMESERIES_PLACEHOLDER;
  if (!sourceLayer?.includes(placeholder)) {
    return drop(`"sourceLayer" does not contain the placeholder ${placeholder}`);
  }

  const rawInterval = num("intervalMs");
  const intervalMs = rawInterval !== undefined && rawInterval > 0 ? rawInterval : DEFAULT_TIMESERIES_INTERVAL_MS;

  return { placeholder, start, end, step, intervalMs };
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
    // Call out the two retired formats by name: they were valid until the
    // renderer became MapLibre-only, so a stale config would otherwise just
    // lose the layer with a generic "invalid format".
    if (layer.format === "parquet" || layer.format === "geoarrow") {
      console.warn(
        `layers.json: layer "${layer.id}" uses format "${layer.format}", which is no ` +
          `longer supported — convert the data to pmtiles/flatgeobuf and update the entry. Skipping.`,
      );
    } else {
      console.warn(`layers.json: layer "${layer.id}" has invalid format "${layer.format}", skipping`);
    }
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
    timeseries: validateTimeseries(
      layer.timeseries,
      layer.id as string,
      layer.sourceLayer as string | undefined,
    ),
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
    attributeSource: isComposite
      ? undefined
      : validateAttributeSource(layer.attributeSource, layer.id as string),
    charts: isComposite ? undefined : validateCharts(layer.charts, layer.id as string),
    statistics: isComposite ? undefined : validateStatistics(layer.statistics, layer.id as string),
    // Not composite-guarded: a composite is the single navigation/legend entry,
    // so its description belongs on the parent.
    description: validateDescription(layer.description, layer.id as string),
    meta: validateMeta(layer.meta, layer.id as string),
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
