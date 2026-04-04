export type LayerFormat = "geoarrow" | "parquet" | "mvt" | "cog";

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
  opacity?: number;
  radius?: number;
  lineWidth?: number;
  filled?: boolean;
  stroked?: boolean;
}

export interface LayerConfig {
  id: string;
  name: string;
  source: string;
  format: LayerFormat;
  geometryType?: GeometryType;
  /** GeoStyler rule-based style (preferred) */
  geostyler?: GeoStylerStyle;
  /** Legacy flat style (used as fallback, required for COG) */
  style: LayerStyle;
}

export interface LayersFile {
  layers: LayerConfig[];
}
