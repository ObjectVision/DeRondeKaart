import type { FeatureCollection } from "geojson";

/**
 * `geojson` is an in-memory format: features are provided on `LayerConfig.data`
 * (e.g. pushed by the Power BI visual via postMessage) instead of fetched from
 * `source`. It is not valid in layers.json.
 */
export type LayerFormat = "mvt" | "cog" | "geojson" | "flatgeobuf" | "pmtiles" | "composite";

export type GeometryType = "point" | "line" | "polygon";

// GeoStyler-based style types

export type FilterOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

/** GeoStyler comparison filter: [operator, propertyName, value] */
export type ComparisonFilter = [FilterOperator, string, string | number | boolean];

/** GeoStyler combination filter: ["&&" | "||", ...filters] */
export type CombinationFilter = ["&&" | "||", ...GeoStylerFilter[]];

/**
 * Presence filter: ["has", propertyName] — true when the feature carries the
 * property at all. A comparison cannot stand in for this: a vector tile simply
 * omits the tag for an unset attribute, so `["==", prop, ""]` is false for a
 * feature that has no such attribute AND for one whose value is genuinely
 * empty. Source data that distinguishes "no value" from "no data" needs both.
 */
export type PresenceFilter = ["has", string];

/** Negation filter: ["!", filter] */
export type NegationFilter = ["!", GeoStylerFilter];

export type GeoStylerFilter =
  | ComparisonFilter
  | CombinationFilter
  | PresenceFilter
  | NegationFilter;

/**
 * MapLibre layer types a rule can render as. The first four are what the
 * symbolizer kinds map to; the rest are only reachable via a `type` override.
 */
export type NativeLayerType =
  | "fill"
  | "line"
  | "circle"
  | "symbol"
  | "fill-extrusion"
  | "heatmap"
  | "raster";

/**
 * Raw MapLibre escape hatch, available on every symbolizer.
 *
 * The symbolizer fields above cover only a small, literal-valued slice of the
 * style spec: no expressions, no dashes or patterns, no text, no extrusion or
 * heatmap. Anything outside that slice goes here and is merged over whatever
 * the symbolizer produced, key by key — so a rule can add `line-dasharray`
 * without restating its colour.
 *
 * Keys are MapLibre style-spec names verbatim ("line-dasharray", not
 * "dashArray"). Values pass through unchanged and UNVALIDATED, matching how the
 * rest of `geostyler` is handled (config.ts casts it without validation).
 *
 * Be aware that MapLibre SILENTLY IGNORES a paint key that doesn't belong to the
 * layer type — a misspelled key renders nothing and reports nothing, so check
 * spelling against the style spec rather than expecting an error. (A malformed
 * *expression* under a valid key does throw at `addLayer`.) Keys left over from
 * the generated paint are harmless for the same reason: a `type: "fill-extrusion"`
 * override keeps its inherited `fill-color` without complaint.
 *
 * Note the legend swatch still reflects the symbolizer's DECLARED colour, not
 * the effective paint — an expression cannot be reduced to one colour. See
 * ruleSwatchSpec in src/lib/legend-style.ts.
 */
export interface RawStyleOverrides {
  /** Merged over the generated `paint`, key by key. */
  paint?: Record<string, unknown>;
  /** Merged over the generated `layout`, key by key. */
  layout?: Record<string, unknown>;
  /**
   * Render as a different MapLibre layer type than the kind implies — the only
   * way to reach `fill-extrusion` or `heatmap`. Must still suit the source's
   * geometry; an unusable pairing is warned about in mvt-style.ts.
   */
  type?: NativeLayerType;
}

export interface FillSymbolizer extends RawStyleOverrides {
  kind: "Fill";
  color?: string;
  opacity?: number;
  outlineColor?: string;
  /**
   * Only `0` has any effect (it makes the outline transparent). MapLibre's
   * `fill-outline-color` is locked to 1px, so any other value renders the same
   * as 1 — a real outline width needs a companion line layer, or a
   * `type: "line"` override with `line-width` here.
   */
  outlineWidth?: number;
  /** Like `outlineWidth`, only `0` has an effect. */
  outlineOpacity?: number;
  /**
   * Draw a diagonal hatch instead of a flat fill, so the class reads as "no
   * value here" rather than as a value of its own. `true` takes the red-on-white
   * defaults in hatch-pattern.ts; an object overrides either colour.
   *
   * `color` is still honoured and stays the rule's declared colour — the hatch
   * paints over it via `fill-pattern`, and it shows through only if the sprite
   * image is missing. Opacity and the outline fields keep working unchanged.
   *
   * The legend swatch renders the same geometry from the same constants, so the
   * map and the legend cannot drift.
   */
  hatch?: boolean | { color?: string; background?: string };
}

export interface LineSymbolizer extends RawStyleOverrides {
  kind: "Line";
  color?: string;
  width?: number;
  opacity?: number;
}

export interface MarkSymbolizer extends RawStyleOverrides {
  kind: "Mark";
  color?: string;
  radius?: number;
  opacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
}

/**
 * Icon symbolizer for point geometry: renders an SVG/PNG image per feature
 * (deck.gl IconLayer) instead of a circle. SVG files must declare explicit
 * width/height attributes to rasterize; `width`/`height` here are the source
 * image's pixel dimensions (required by deck.gl to size the texture).
 */
export interface IconSymbolizer extends RawStyleOverrides {
  kind: "Icon";
  /** Image URL (absolute or app-public path, e.g. "/poi-school.svg"). */
  image: string;
  /** Source image pixel width. */
  width: number;
  /** Source image pixel height. */
  height: number;
  /** Rendered height in screen px; defaults to `height`. */
  size?: number;
  opacity?: number;
  /**
   * Tint color (hex). When set, the image is treated as a mask — its shape is
   * kept but every opaque pixel is recolored (the SVG's own fill is ignored).
   * Omit to render the image's own colors.
   */
  color?: string;
  /**
   * Vertical anchor in image pixels from the top; defaults to height/2
   * (centered). Use `height` for bottom-anchored pin-style icons.
   */
  anchorY?: number;
}

export type GeoStylerSymbolizer =
  | FillSymbolizer
  | LineSymbolizer
  | MarkSymbolizer
  | IconSymbolizer;

/**
 * One legend class: a name, an optional filter selecting its features, and the
 * symbolizer that draws them.
 *
 * `name` is load-bearing well beyond styling — it is the legend label, the key
 * for per-class visibility toggles, and (via layerId) the suffix of the MapLibre
 * layer id that picking, restacking and the timeseries rebuild all derive.
 * It must stay stable and unique within its layer.
 *
 * Rule-level `paint`/`layout`/`type` are read only when `symbolizers` is empty,
 * which is how a layer is hand-written in raw MapLibre while keeping a legend
 * entry; otherwise put overrides on the symbolizer.
 *
 * `symbolizers` is therefore OPTIONAL, and omitting it is the supported way to
 * write that raw form — a `type: "line"` override needs it, since a Fill
 * symbolizer's generated `fill-*` paint keys are rejected by a line layer. It
 * was previously typed as required, which told every call site that
 * `rule.symbolizers[0]` was safe; several then threw on a rule that legitimately
 * had none. Index it with `?.[0]`.
 */
export interface GeoStylerRule extends RawStyleOverrides {
  name: string;
  filter?: GeoStylerFilter;
  symbolizers?: GeoStylerSymbolizer[];
}

export interface GeoStylerStyle {
  name?: string;
  rules: GeoStylerRule[];
}

// Legacy flat style (kept for backwards compatibility / COG layers)
export interface LayerStyle {
  color?: [number, number, number] | [number, number, number, number];
  /** Outline/stroke color; falls back to `color` when omitted (geojson format). */
  lineColor?: [number, number, number] | [number, number, number, number];
  opacity?: number;
  radius?: number;
  lineWidth?: number;
  filled?: boolean;
  stroked?: boolean;
  /** Point geometry only: render an SVG/PNG icon per feature instead of a circle. */
  icon?: {
    /** Image URL (absolute or app-public path). SVG needs explicit width/height attributes. */
    url: string;
    /** Source image pixel width. */
    width: number;
    /** Source image pixel height. */
    height: number;
    /** Rendered height in screen px; defaults to `height`. */
    size?: number;
    /** Tint color (hex): recolors the image's opaque pixels (mask rendering). */
    color?: string;
    /** Vertical anchor in image px from the top; defaults to height/2 (centered). */
    anchorY?: number;
  };
}

/** How a chart/statistic value is displayed. */
export type ChartValueFormat = "number" | "percent" | "currency";

/** One "Kerncijfers" statistic card in the analytics panel. */
export interface StatisticConfig {
  /** Numeric field of the layer's attribute table. */
  field: string;
  /** Which statistic of the field to show. */
  stat: "sum" | "count" | "mean" | "variance";
  /** Card label, e.g. "Woningen". */
  label: string;
  /** Material Symbols icon name, e.g. "home". */
  icon: string;
  /** Icon color; defaults to the brand blue. */
  color?: string;
  /** Value display format; defaults to "number". */
  format?: ChartValueFormat;
}

export interface FeatureInfoConfig {
  /** Inline HTML template string with [[ param ]] placeholders */
  template?: string;
  /** Path to an .html file containing the template */
  templateUrl?: string;
  /**
   * Show PBL's "Samenvatting Startanalyse" for the clicked neighbourhood instead
   * of a rendered template. Requires the feature to carry a `bu_code`.
   *
   * Takes precedence over `template`/`templateUrl`: the two are alternative ways
   * to answer the same click, never combined. The template is left in place in
   * layers.json because it holds fields the summary does not show, so dropping
   * this flag restores the table without recovering any data.
   */
  pbl?: boolean;
}

/**
 * Timeseries playback over a vector-tile archive that holds the same theme at
 * several moments in time, one source layer per step (e.g. `2025_aandeel_…`,
 * `2030_aandeel_…`). The layer's `sourceLayer` carries `placeholder` where the
 * step value goes, and the legend gains a play/pause control plus a slider.
 */
export interface TimeseriesConfig {
  /** Token in `sourceLayer` replaced by the current step. Default "%YEAR%". */
  placeholder: string;
  /** First step, and the value the layer starts on. */
  start: number;
  /** Last step (inclusive). Playback loops back to `start` after it. */
  end: number;
  /** Increment between steps. Must be > 0. */
  step: number;
  /** Milliseconds per step while playing. Default 1000. */
  intervalMs: number;
}

export interface LayerConfig {
  id: string;
  name: string;
  source: string;
  format: LayerFormat;
  geometryType?: GeometryType;
  /** For MVT/PMTiles: the source layer name within the tileset to render */
  sourceLayer?: string;
  /**
   * MVT/PMTiles only: step `sourceLayer` through time. Requires `sourceLayer`
   * to contain the placeholder token.
   */
  timeseries?: TimeseriesConfig;
  /** GeoStyler rule-based style (preferred) */
  geostyler?: GeoStylerStyle;
  /** Legacy flat style (used as fallback, required for COG) */
  style: LayerStyle;
  /** HTML template for feature click popups */
  featureinfo?: FeatureInfoConfig;
  /** If true, the layer is rendered on the map but hidden from the legend */
  excludeFromLegend?: boolean;
  /** If true, the layer is rendered on the map but excluded from feature picking — clicks produce no popup for it */
  excludeFromPicking?: boolean;
  /**
   * Outline the feature under the pointer, and the one a click opened, in
   * `highlightcolor`. Vector formats only (mvt/pmtiles/flatgeobuf).
   *
   * Load-time, not a runtime toggle: highlighting needs a stable `feature.id`,
   * which vector tiles only carry when the source is created with `promoteId`
   * (verified — without it `setFeatureState` silently does nothing). The source
   * would have to be recreated to change this.
   */
  highlightable?: boolean;
  /** CSS colour of the highlight outline. Defaults to HIGHLIGHT_COLOR. */
  highlightcolor?: string;
  /**
   * Draw a wider line UNDER the highlight outline, so the selection stays
   * legible on a basemap it would otherwise blend into. `true` takes the
   * white / 2px-per-side defaults in feature-id.ts; an object overrides either.
   *
   * Off by default rather than always on: a layer that draws its own filled
   * polygons already supplies the contrast, and the casing would only thicken
   * the selection there.
   */
  highlightcasing?: boolean | { color?: string; width?: number };
  /**
   * Offer this layer's features for the dashboard's area comparison: a click
   * assigns the feature one of four numbered slots, each outlined in its own
   * colour (see `compare-slots.ts`).
   *
   * Load-time and opt-in for the same reason as `highlightable`, whose
   * `promoteId` it depends on: a layer cannot start carrying stable feature ids
   * without recreating its source. `dashboard_complementary.json` picks which
   * of the opted-in layers serves gemeente and which serves buurt; this only
   * says the layer is eligible.
   */
  compareSelectable?: boolean;
  /**
   * Property holding a stable, unique feature id, used as `promoteId`.
   * Auto-detected from ID_CANDIDATES when omitted; set this when the layer
   * keys on something else, or when a candidate matches but is not unique.
   */
  idProperty?: string;
  /** If true, presence of this layer on BOTH maps suppresses comparison mode (slider hides, the right map is not rendered) */
  excludeFromComparison?: boolean;
  /**
   * Which z-order band the layer is inserted into, named by the anchor layer it
   * sits below. One of the ANCHORS ids in MapView (`background-layers`,
   * `map-layers`, `overlay-layers`, `foreground-layers`, `studyarea-layers`).
   * Omitted → `map-layers` (below the basemap label/road/water overlay).
   * `foreground-layers` puts the layer above that overlay.
   */
  beforeid?: string;
  /**
   * Lower zoom bound. For "flatgeobuf": below this zoom nothing is fetched or
   * shown (default 12 — viewport bbox reads over a large file would otherwise
   * cover the whole dataset when zoomed out). For a "composite" child: the
   * child only loads while `minzoom <= zoom < maxzoom` (default 0).
   */
  minzoom?: number;
  /**
   * Upper zoom bound (exclusive, MapLibre convention). For a "composite"
   * child: the child unloads at and above this zoom (default 24). Also
   * stamped on native MapLibre layer specs for an exact mid-gesture cutoff.
   */
  maxzoom?: number;
  /**
   * "composite" only: the child layer configs this composite is composed of.
   * Children are full layer configs (any format except "composite"/"geojson")
   * with synthesized ids `${parentId}__c${index}`; each child loads only while
   * the map zoom is inside its [minzoom, maxzoom) range. The composite itself
   * is the single navigation/legend/share entry — its own `geostyler` drives
   * the legend and its `featureinfo` the popups.
   */
  layers?: LayerConfig[];
  /** COG only: the raster already contains its colors; geostyler rules are shown in the legend but NOT applied as a per-pixel color function. */
  embeddedColors?: boolean;
  /** "geojson" format only: the in-memory features to render. `source` is unused ("") for this format. */
  data?: FeatureCollection;
  /**
   * Attribute table for the analytics panel, when `source` is a format that has
   * none the app can read whole (pmtiles/mvt/cog serve tiles, not tables).
   *
   * Charts aggregate the ENTIRE dataset, so they cannot be computed from vector
   * tiles: those only hold the current viewport at the current zoom, and the
   * numbers would silently change as the user pans. Point this at a `.parquet`
   * (or `.arrow`) sidecar carrying the same rows and the panel reads that
   * instead, while the map keeps rendering from `source`.
   */
  attributeSource?: string;
  /** Ids of charts.json chart definitions shown in the analytics panel (max 4 used). */
  charts?: string[];
  /** Statistic cards ("Kerncijfers") shown in the analytics panel. */
  statistics?: StatisticConfig[];
  /**
   * Brief plain-text summary of what the layer shows, rendered inline in the
   * navigation info panel (see LayerDescription). The long-form HTML lives in
   * `meta` and opens in the metainfo dialog instead.
   */
  description?: string;
  /**
   * Short subtitle shown under the layer name in the legend — in practice the
   * unit the layer's values are measured in ("GJ/jaar per WEQ", "ton CO₂/jaar").
   * Carried into the PNG and circular exports alongside the name.
   *
   * Distinct from `description`: one line that qualifies the name, not a summary
   * of the dataset.
   */
  subname?: string;
  /**
   * URL of a companion single-band COG holding this layer's **class ordinals**
   * on the shared uniform grid — the output of
   * `data/convert-tif-to-cog-10m.py`. Band value = the index of the matching
   * `geostyler.rules` entry; 255 = nodata.
   *
   * Its presence is what makes a layer eligible for "Criteria combineren": classes
   * can only be combined cell-by-cell when every input is on the same grid, so a
   * layer without this companion is not offered. Every raster referenced here
   * must have been produced at the SAME `--zoom` as the others.
   *
   * On a timeseries layer this is a TEMPLATE carrying `timeseries.placeholder`,
   * resolved to the step the legend shows when the combination is created (see
   * `filterRasterForStep`). The resulting score grid is a snapshot: moving the
   * slider afterwards repaints the vector layer but leaves the combination on
   * the step it was built from.
   */
  filterRaster?: string;
  /**
   * Path to an HTML fragment describing the dataset, e.g.
   * "/data/meta/huisarts.html". Fetched on demand and rendered in the metainfo
   * dialog (see LeafMeta), opened from the legend's info button or from under
   * the navigation description. Describes the data, not the menu position —
   * which is why it lives here and not on a navigation leaf.
   *
   * An ARRAY composes the dialog from several fragments, concatenated verbatim in
   * array order. That lets text shared by many layers live in one file instead of
   * being copy-pasted into each variant:
   *
   *   "meta": ["LN_H10_specific.html", "LN_default.html"]
   *
   * Fragments are fetched in parallel and cached per URL, so a shared base file is
   * only ever fetched once no matter how many layers reference it. A fragment that
   * fails to load is skipped with a warning; the rest still render.
   *
   * Note that each published fragment carries its own boilerplate (a `<link>`, a
   * `<head>` and a trailing `<footer>`), so composing two of them repeats the
   * footer. Nothing is stripped or rewritten — see LeafMeta.
   */
  meta?: string | string[];
}

export interface LayersFile {
  layers: LayerConfig[];
}
