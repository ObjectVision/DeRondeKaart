import type { FeatureCollection } from "geojson";

/**
 * "geojson" is an in-memory format: features are provided on `LayerConfig.data`
 * (e.g. pushed by the Power BI visual via postMessage) instead of fetched from
 * `source`. It is not valid in layers.json.
 */
export type LayerFormat = "geoarrow" | "geoparquet" | "parquet" | "mvt" | "cog" | "geojson";

export type GeometryType = "point" | "line" | "polygon";

// GeoStyler-based style types

export type FilterOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

/** GeoStyler comparison filter: [operator, propertyName, value] */
export type ComparisonFilter = [FilterOperator, string, string | number | boolean];

/** GeoStyler combination filter: ["&&" | "||", ...filters] */
export type CombinationFilter = ["&&" | "||", ...GeoStylerFilter[]];

export type GeoStylerFilter = ComparisonFilter | CombinationFilter;

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

export type GeoStylerSymbolizer = FillSymbolizer | LineSymbolizer | MarkSymbolizer;

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

export interface LayerConfig {
  id: string;
  name: string;
  source: string;
  format: LayerFormat;
  geometryType?: GeometryType;
  /** For MVT: the source layer name within the tileset to render */
  sourceLayer?: string;
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
  /** COG only: the raster already contains its colors; geostyler rules are shown in the legend but NOT applied as a per-pixel color function. */
  embeddedColors?: boolean;
  /** "geojson" format only: the in-memory features to render. `source` is unused ("") for this format. */
  data?: FeatureCollection;
  /** Ids of charts.json chart definitions shown in the analytics panel (max 4 used). */
  charts?: string[];
  /** Statistic cards ("Kerncijfers") shown in the analytics panel. */
  statistics?: StatisticConfig[];
}

export interface LayersFile {
  layers: LayerConfig[];
}
