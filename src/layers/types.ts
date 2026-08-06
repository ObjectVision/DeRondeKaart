import type { FeatureCollection } from "geojson";

/**
 * "geojson" is an in-memory format: features are provided on `LayerConfig.data`
 * (e.g. pushed by the Power BI visual via postMessage) instead of fetched from
 * `source`. It is not valid in layers.json.
 */
export type LayerFormat = "geoarrow" | "parquet" | "mvt" | "cog" | "geojson" | "flatgeobuf" | "pmtiles" | "composite";

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

export interface FillSymbolizer {
  kind: "Fill";
  color?: string;
  opacity?: number;
  outlineColor?: string;
  outlineWidth?: number;
  outlineOpacity?: number;
}

export interface LineSymbolizer {
  kind: "Line";
  color?: string;
  width?: number;
  opacity?: number;
}

export interface MarkSymbolizer {
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
export interface IconSymbolizer {
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

export interface GeoStylerRule {
  name: string;
  filter?: GeoStylerFilter;
  symbolizers: GeoStylerSymbolizer[];
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
   * Path to an HTML fragment describing the dataset, e.g.
   * "/data/meta/huisarts.html". Fetched on demand and rendered in the
   * navigation info panel (see LeafMeta). Describes the data, not the menu
   * position — which is why it lives here and not on a navigation leaf.
   */
  meta?: string;
}

export interface LayersFile {
  layers: LayerConfig[];
}
