import type { Layer, Color } from "@deck.gl/core";
import { GeoJsonLayer, IconLayer } from "@deck.gl/layers";
import { Table, RecordBatch } from "apache-arrow";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-geoarrow";
import type { LayerConfig, GeoStylerStyle, GeoStylerRule, IconSymbolizer } from "./types";
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
  getIconFromRule,
  getOpacityFromStyle,
  hexToColor,
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

// ---------------------------------------------------------------------------
// Icon symbology (point geometry): deck.gl core IconLayer fed with the
// GeoArrow point coordinates as a binary attribute — @geoarrow/deck.gl-geoarrow
// has no icon layer, so this bridges the batch to deck directly.
// ---------------------------------------------------------------------------

/** Icon settings shared by the flat `style.icon` and the Icon symbolizer. */
type IconSpec = Pick<IconSymbolizer, "width" | "height" | "size" | "color" | "anchorY"> & {
  url: string;
};

/**
 * Per-row tint for an icon layer. With a configured `color` the icon renders
 * as a mask and this RGB recolors it; without one only the alpha matters
 * (visibility gating) and the image keeps its own colors.
 */
function iconTint(icon: IconSpec): Color {
  return icon.color ? hexToColor(icon.color) : [255, 255, 255, 255];
}

/**
 * Extract a geoarrow.point column's coordinates as a flat interleaved array
 * for deck's binary attribute interface. Supports the interleaved
 * (FixedSizeList) and separated (Struct x/y) GeoArrow point encodings;
 * returns null for multipoint or missing point columns (caller falls back to
 * the circle scatterplot rendering).
 */
function pointPositionAttribute(
  batch: RecordBatch,
): { value: Float64Array; size: number } | null {
  const fields = batch.schema.fields;
  for (let i = 0; i < fields.length; i++) {
    const ext = fields[i].metadata.get("ARROW:extension:name");
    if (ext !== "geoarrow.point") continue;

    const data = batch.getChildAt(i)?.data?.[0];
    if (!data) return null;

    const type = fields[i].type as { listSize?: number };
    if (typeof type.listSize === "number") {
      // Interleaved: FixedSizeList<double>[listSize] — one flat child buffer.
      const child = (data as { children?: Array<{ values?: unknown }> }).children?.[0];
      const values = child?.values;
      if (!(values instanceof Float64Array)) return null;
      const start = data.offset * type.listSize;
      return {
        value: values.subarray(start, start + data.length * type.listSize),
        size: type.listSize,
      };
    }

    // Separated: Struct<x: double, y: double> — interleave a copy.
    const children = (data as { children?: Array<{ values?: unknown }> }).children;
    const xs = children?.[0]?.values;
    const ys = children?.[1]?.values;
    if (!(xs instanceof Float64Array) || !(ys instanceof Float64Array)) return null;
    const out = new Float64Array(data.length * 2);
    for (let r = 0; r < data.length; r++) {
      out[r * 2] = xs[data.offset + r];
      out[r * 2 + 1] = ys[data.offset + r];
    }
    return { value: out, size: 2 };
  }
  return null;
}

/** Warn once per config when icon symbology can't bind to the geometry. */
const iconFallbackWarned = new Set<string>();

/**
 * Build an IconLayer for one record batch. `getColor`'s alpha channel gates
 * per-row visibility (deck fades non-masked icons by the color's alpha), which
 * is how the shared rule/area-filter accessors — returning TRANSPARENT for
 * dropped rows — carry over to icons. The batch rides on `data.data`, so the
 * accessors see the same `info.data.data` shape as the GeoArrow layers, and
 * picking can resolve `batch.get(index)` for the feature-info popup.
 */
function createIconPointLayer(
  layerId: string,
  batch: RecordBatch,
  positions: { value: Float64Array; size: number },
  icon: IconSpec,
  getColor: (info: ArrowAccessorInfo) => Color,
  opacity: number,
  beforeId?: string,
): Layer {
  return new IconLayer({
    id: layerId,
    data: {
      length: batch.numRows,
      data: batch,
      attributes: { getPosition: positions },
    },
    pickable: true,
    getIcon: () => ({
      // Mask rendering shares no texture state with non-mask use of the same
      // image — key the atlas entry on it so both variants can coexist.
      id: `${icon.url}${icon.color ? "#mask" : ""}`,
      url: icon.url,
      width: icon.width,
      height: icon.height,
      anchorY: icon.anchorY ?? icon.height / 2,
      // Mask = recolorable: the image's opaque shape is tinted by getColor.
      mask: Boolean(icon.color),
    }),
    getSize: icon.size ?? icon.height,
    sizeUnits: "pixels",
    // deck CORE layers call accessors as (object, info) — object is undefined
    // for binary-attribute data. The shared rule/area-filter accessors expect
    // the GeoArrow single-argument shape {index, data: {data: batch}}, which
    // `info` already matches (data = our data prop) — adapt the convention.
    getColor: (_object: unknown, info: { index: number; data: { data: RecordBatch } }) =>
      getColor(info),
    opacity,
    updateTriggers: areaFilterTriggers(),
    beforeId,
  } as any);
}

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
    case "point": {
      if (style.icon) {
        const positions = pointPositionAttribute(batch);
        if (positions) {
          return createIconPointLayer(
            layerId,
            batch,
            positions,
            style.icon,
            // Tint (or opaque white for own-color icons); the alpha channel
            // gates area-filter drops either way.
            withAreaFilter(iconTint(style.icon)),
            style.opacity ?? 1,
            beforeId,
          );
        }
        if (!iconFallbackWarned.has(config.id)) {
          iconFallbackWarned.add(config.id);
          console.warn(
            `Layer "${config.id}": icon symbology needs a geoarrow.point column — falling back to circles`,
          );
        }
      }
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
    }

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
    case "point": {
      const iconSym = getIconFromRule(rule);
      if (iconSym) {
        const positions = pointPositionAttribute(batch);
        if (positions) {
          const spec = { ...iconSym, url: iconSym.image };
          return createIconPointLayer(
            layerId,
            batch,
            positions,
            spec,
            // Tint for rows won by this rule, TRANSPARENT otherwise — the
            // alpha gates both the rule match and the area filter.
            withAreaFilter(
              buildArrowRuleColorAccessor(geostyler, rule, () => iconTint(spec)),
            ),
            iconSym.opacity ?? opacity,
            beforeId,
          );
        }
        if (!iconFallbackWarned.has(config.id)) {
          iconFallbackWarned.add(config.id);
          console.warn(
            `Layer "${config.id}": icon symbology needs a geoarrow.point column — falling back to circles`,
          );
        }
      }
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
    }

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
