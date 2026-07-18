import type { Layer, Color } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import { Table, RecordBatch } from "apache-arrow";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-geoarrow";
import type { LayerConfig, GeoStylerStyle, GeoStylerRule } from "./types";
import { arrowRowMatchesAreaFilter, getAreaFilterVersion } from "./area-filter";
import {
  evaluateFilter,
  getFillColorFromRule,
  getOutlineColorFromRule,
  getOutlineWidthFromRule,
  getLineColorFromRule,
  getLineWidthFromRule,
  getMarkColorFromRule,
  getMarkRadiusFromRule,
  getOpacityFromStyle,
} from "./geostyler";

function toColor(
  c: [number, number, number] | [number, number, number, number] | undefined,
  fallback: Color,
): Color {
  if (!c) return fallback;
  return c as Color;
}

/**
 * Build an accessor function that only returns color for features matching a
 * specific rule, and TRANSPARENT for everything else.
 */
const TRANSPARENT: Color = [0, 0, 0, 0];

/** Arrow record batch shape seen by GeoArrow layer accessors. */
type ArrowBatch = {
  numRows: number;
  getChild: (name: string) => { get: (i: number) => unknown } | null;
};

/** deck.gl accessor info shape for GeoArrow layers (binary data + row index). */
type ArrowAccessorInfo = {
  index: number;
  data: { data: ArrowBatch };
};

/** Collect the field names referenced across all rule filters, once. */
function collectFilterFields(style: GeoStylerStyle): string[] {
  const filterFields = new Set<string>();
  for (const r of style.rules) {
    if (r.filter) extractFilterFields(r.filter).forEach((f) => filterFields.add(f));
  }
  return Array.from(filterFields);
}

/**
 * Per-record-batch memo of the winning rule index per row (-1 = no rule
 * matches). Computed in a single pass with the column handles hoisted out of
 * the row loop, so styling costs O(rows × rules) once per batch — instead of
 * every rule layer's accessor re-walking every rule per row (O(rows × rules²)
 * plus a hex parse per call). Keyed weakly on the batch so the cache is shared
 * across rule layers, both maps, and area-filter re-evaluations.
 */
const ruleIndexCache = new WeakMap<object, globalThis.Map<GeoStylerStyle, Int32Array>>();

function ruleIndexColumn(batch: ArrowBatch, style: GeoStylerStyle): Int32Array {
  let byStyle = ruleIndexCache.get(batch);
  if (!byStyle) {
    byStyle = new globalThis.Map();
    ruleIndexCache.set(batch, byStyle);
  }
  const cached = byStyle.get(style);
  if (cached) return cached;

  const fields = collectFilterFields(style);
  const cols = fields.map((f) => batch.getChild(f));
  const rules = style.rules;
  const props: Record<string, unknown> = {};
  const out = new Int32Array(batch.numRows).fill(-1);
  for (let i = 0; i < batch.numRows; i++) {
    for (let f = 0; f < fields.length; f++) {
      const col = cols[f];
      if (col) props[fields[f]] = col.get(i);
    }
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r];
      if (!rule.filter || evaluateFilter(rule.filter, props)) {
        out[i] = r;
        break;
      }
    }
  }
  byStyle.set(style, out);
  return out;
}

function buildArrowRuleColorAccessor(
  style: GeoStylerStyle,
  rule: GeoStylerRule,
  extractor: (rule: GeoStylerRule) => Color,
) {
  // The color is invariant within a rule layer — resolve it (symbolizer find +
  // hex parse) once here. The accessor only answers "does this row's winning
  // rule equal this layer's rule?" via the precomputed index column.
  const ruleIndex = style.rules.indexOf(rule);
  const color = extractor(rule);

  return (info: ArrowAccessorInfo) =>
    ruleIndexColumn(info.data.data, style)[info.index] === ruleIndex ? color : TRANSPARENT;
}

/**
 * Wrap a color (constant or accessor) so rows outside the active area filter
 * render TRANSPARENT — the same convention as the rule accessors above.
 */
function withAreaFilter(
  accessor: Color | ((info: ArrowAccessorInfo) => Color),
): (info: ArrowAccessorInfo) => Color {
  return (info) => {
    if (!arrowRowMatchesAreaFilter(info)) return TRANSPARENT;
    return typeof accessor === "function" ? accessor(info) : accessor;
  };
}

/** updateTriggers so a filter change re-evaluates all accessor attributes. */
const areaFilterTriggers = () => ({ all: `area-filter-${getAreaFilterVersion()}` });

/** Extract all field names referenced in a filter tree */
function extractFilterFields(filter: unknown[]): string[] {
  const op = filter[0] as string;
  if (op === "&&" || op === "||") {
    return filter.slice(1).flatMap((f) => extractFilterFields(f as unknown[]));
  }
  return [filter[1] as string];
}

/**
 * Create deck.gl layers for a GeoArrow/Parquet source.
 *
 * @geoarrow/deck.gl-geoarrow (v0.4+) takes one Arrow RecordBatch per layer
 * instance, so this returns one layer per batch — times one per GeoStyler rule
 * when the config has geostyler styling.
 *
 * Layer ids are stable across progressive batch emissions (the loaders emit
 * cumulative tables, so batch i keeps position i): re-emitted batches REPLACE
 * their previous layer via deck's id-matched diff (a no-op — same RecordBatch
 * instance), and only genuinely new batches append. The `__b{n}` segment uses
 * a distinct separator so config-id prefix matching (`configId-…`) and rule
 * suffix matching (`…-{ruleName}`) in use-map-layers stay unambiguous.
 */
export function createGeoArrowLayers(
  config: LayerConfig,
  table: Table,
  beforeId?: string,
): Layer[] {
  const baseId = config.id;
  const { geostyler } = config;
  const geometryType = config.geometryType ?? detectGeometryType(table);

  return table.batches.flatMap((batch, i) => {
    const batchId = `${baseId}__b${i}`;
    if (geostyler && geostyler.rules.length > 0) {
      return geostyler.rules.map((rule) =>
        createRuleGeoArrowLayer(
          `${batchId}-${rule.name}`,
          config,
          batch,
          geometryType,
          geostyler,
          rule,
          beforeId,
        ),
      );
    }
    return [createFlatGeoArrowLayer(batchId, config, batch, geometryType, beforeId)];
  });
}

/** Create a single GeoArrow layer for one record batch with the legacy flat style. */
function createFlatGeoArrowLayer(
  layerId: string,
  config: LayerConfig,
  batch: RecordBatch,
  geometryType: string,
  beforeId?: string,
): Layer {
  const { style } = config;

  switch (geometryType) {
    case "point":
      return new GeoArrowScatterplotLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getFillColor: withAreaFilter(toColor(style.color, [0, 128, 255, 200])),
        getRadius: style.radius ?? 5,
        radiusUnits: "pixels",
        opacity: style.opacity ?? 1,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getColor: withAreaFilter(toColor(style.color, [0, 128, 255, 200])),
        getWidth: style.lineWidth ?? 2,
        widthUnits: "pixels",
        opacity: style.opacity ?? 1,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getFillColor: withAreaFilter(toColor(style.color, [0, 128, 255, 100])),
        getLineColor: withAreaFilter(toColor(style.lineColor ?? style.color, [0, 128, 255, 200])),
        getLineWidth: style.lineWidth ?? 1,
        lineWidthUnits: "pixels",
        filled: style.filled ?? true,
        stroked: style.stroked ?? true,
        opacity: style.opacity ?? 1,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    default:
      throw new Error(
        `Unknown geometry type "${geometryType}" for layer "${config.id}"`,
      );
  }
}

/** Create a single GeoArrow layer for one record batch and one GeoStyler rule. */
function createRuleGeoArrowLayer(
  layerId: string,
  config: LayerConfig,
  batch: RecordBatch,
  geometryType: string,
  geostyler: GeoStylerStyle,
  rule: GeoStylerRule,
  beforeId?: string,
): Layer {
  const opacity = getOpacityFromStyle(geostyler);

  switch (geometryType) {
    case "point":
      return new GeoArrowScatterplotLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getFillColor: withAreaFilter(buildArrowRuleColorAccessor(geostyler, rule, getMarkColorFromRule)),
        getRadius: getMarkRadiusFromRule(rule),
        radiusUnits: "pixels",
        opacity,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getColor: withAreaFilter(buildArrowRuleColorAccessor(geostyler, rule, getLineColorFromRule)),
        getWidth: getLineWidthFromRule(rule),
        widthUnits: "pixels",
        opacity,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: batch,
        pickable: true,
        getFillColor: withAreaFilter(buildArrowRuleColorAccessor(geostyler, rule, getFillColorFromRule)),
        getLineColor: withAreaFilter(buildArrowRuleColorAccessor(geostyler, rule, getOutlineColorFromRule)),
        getLineWidth: getOutlineWidthFromRule(rule),
        lineWidthUnits: "pixels",
        filled: true,
        stroked: true,
        opacity,
        updateTriggers: areaFilterTriggers(),
        beforeId,
      } as any);

    default:
      throw new Error(
        `Unknown geometry type "${geometryType}" for layer "${config.id}"`,
      );
  }
}

/**
 * Attempts to detect the geometry type from the Arrow table schema.
 * Falls back to "point" if detection fails.
 */
function detectGeometryType(
  table: Table,
): "point" | "line" | "polygon" {
  const schema = table.schema;
  for (const field of schema.fields) {
    const geoMeta = field.metadata.get("ARROW:extension:name");
    if (!geoMeta) continue;

    if (
      geoMeta.includes("geoarrow.point") ||
      geoMeta.includes("geoarrow.multipoint")
    ) {
      return "point";
    }
    if (
      geoMeta.includes("geoarrow.linestring") ||
      geoMeta.includes("geoarrow.multilinestring")
    ) {
      return "line";
    }
    if (
      geoMeta.includes("geoarrow.polygon") ||
      geoMeta.includes("geoarrow.multipolygon")
    ) {
      return "polygon";
    }
  }

  // Fallback: default to point
  return "point";
}

/**
 * Create a deck.gl layer for the in-memory "geojson" format (`config.data`),
 * used by dynamically pushed data such as the Power BI bridge. One GeoJsonLayer
 * renders points, lines and (multi)polygons uniformly, styled from the flat
 * `config.style` — the same LayerStyle the legend renders as a swatch.
 * The area filter intentionally does not apply to this in-memory embed data.
 */
export function createGeoJsonLayers(config: LayerConfig, beforeId?: string): Layer[] {
  const { style, data } = config;
  if (!data || data.features.length === 0) return [];

  return [
    new GeoJsonLayer({
      id: `${config.id}-geojson`,
      data,
      pickable: true,
      pointType: "circle",
      filled: style.filled ?? true,
      stroked: style.stroked ?? true,
      getFillColor: toColor(style.color, [0, 128, 255, 150]),
      getLineColor: toColor(style.lineColor ?? style.color, [0, 128, 255, 200]),
      getPointRadius: style.radius ?? 5,
      pointRadiusUnits: "pixels",
      getLineWidth: style.lineWidth ?? 2,
      lineWidthUnits: "pixels",
      opacity: style.opacity ?? 1,
      beforeId,
    } as unknown as ConstructorParameters<typeof GeoJsonLayer>[0]),
  ];
}
