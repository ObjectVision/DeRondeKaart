import type { Layer, Color } from "@deck.gl/core";
import { Table } from "apache-arrow";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-layers";
import type { LayerConfig } from "./types";

function toColor(
  c: [number, number, number] | [number, number, number, number] | undefined,
  fallback: Color,
): Color {
  if (!c) return fallback;
  return c as Color;
}

export function createGeoArrowLayer(
  config: LayerConfig,
  table: Table,
  batchIndex: number,
): Layer {
  const layerId = `${config.id}-batch-${batchIndex}`;
  const { style } = config;
  const geometryType = config.geometryType ?? detectGeometryType(table);

  switch (geometryType) {
    case "point":
      return new GeoArrowScatterplotLayer({
        id: layerId,
        data: table,
        getFillColor: toColor(style.color, [0, 128, 255, 200]),
        getRadius: style.radius ?? 5,
        radiusUnits: "pixels",
        opacity: style.opacity ?? 1,
      });

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: table,
        getColor: toColor(style.color, [0, 128, 255, 200]),
        getWidth: style.lineWidth ?? 2,
        widthUnits: "pixels",
        opacity: style.opacity ?? 1,
      });

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: table,
        getFillColor: toColor(style.color, [0, 128, 255, 100]),
        getLineColor: toColor(style.color, [0, 128, 255, 200]),
        getLineWidth: style.lineWidth ?? 1,
        lineWidthUnits: "pixels",
        filled: style.filled ?? true,
        stroked: style.stroked ?? true,
        opacity: style.opacity ?? 1,
      });

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
