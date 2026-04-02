export type LayerFormat = "geoarrow" | "parquet" | "mvt" | "cog";

export type GeometryType = "point" | "line" | "polygon";

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
  style: LayerStyle;
}

export interface LayersFile {
  layers: LayerConfig[];
}
