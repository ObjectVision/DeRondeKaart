import type { Layer, Color } from "@deck.gl/core";
import { Table } from "apache-arrow";
import { MVTLayer } from "@deck.gl/geo-layers";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-layers";
import type { LayerConfig, GeoStylerStyle } from "./types";
import {
  matchRule,
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
 * Build an accessor function that evaluates GeoStyler rules per feature.
 * For GeoArrow layers, the accessor receives (object, {index, data, target}) —
 * we need to read attribute values from the Arrow batch.
 */
function buildArrowColorAccessor(
  style: GeoStylerStyle,
  extractor: (rule: ReturnType<typeof matchRule>) => Color,
  fallback: Color,
) {
  // Pre-extract all field names referenced in filters
  const filterFields = new Set<string>();
  for (const rule of style.rules) {
    if (rule.filter) {
      extractFilterFields(rule.filter).forEach((f) => filterFields.add(f));
    }
  }
  const fields = Array.from(filterFields);

  // GeoArrow layers call the accessor with a single argument:
  // { index, data: { data: RecordBatch, ... }, target }
  return (info: { index: number; data: { data: { getChild: (name: string) => { get: (i: number) => unknown } | null } } }) => {
    const batch = info.data.data;
    const props: Record<string, unknown> = {};

    for (const field of fields) {
      const col = batch.getChild(field);
      if (col) props[field] = col.get(info.index);
    }

    const matched = matchRule(style, props);
    return matched ? extractor(matched) : fallback;
  };
}

/** Extract all field names referenced in a filter tree */
function extractFilterFields(filter: unknown[]): string[] {
  const op = filter[0] as string;
  if (op === "&&" || op === "||") {
    return filter.slice(1).flatMap((f) => extractFilterFields(f as unknown[]));
  }
  return [filter[1] as string];
}

export function createGeoArrowLayer(
  config: LayerConfig,
  table: Table,
  batchIndex: number,
): Layer {
  const layerId = `${config.id}-batch-${batchIndex}`;
  const { style, geostyler } = config;
  const geometryType = config.geometryType ?? detectGeometryType(table);

  // If GeoStyler rules are defined, use conditional styling
  if (geostyler && geostyler.rules.length > 0) {
    return createStyledGeoArrowLayer(layerId, config, table, geometryType, geostyler);
  }

  // Fallback to legacy flat style
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

function createStyledGeoArrowLayer(
  layerId: string,
  config: LayerConfig,
  table: Table,
  geometryType: string,
  geostyler: GeoStylerStyle,
): Layer {
  const opacity = getOpacityFromStyle(geostyler);

  switch (geometryType) {
    case "point":
      return new GeoArrowScatterplotLayer({
        id: layerId,
        data: table,
        getFillColor: buildArrowColorAccessor(geostyler, (r) =>
          r ? getMarkColorFromRule(r) : [0, 128, 255, 200],
          [0, 128, 255, 200],
        ),
        getRadius: geostyler.rules[0]
          ? getMarkRadiusFromRule(geostyler.rules[0])
          : 5,
        radiusUnits: "pixels",
        opacity,
      } as any);

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: table,
        getColor: buildArrowColorAccessor(geostyler, (r) =>
          r ? getLineColorFromRule(r) : [0, 128, 255, 200],
          [0, 128, 255, 200],
        ),
        getWidth: geostyler.rules[0]
          ? getLineWidthFromRule(geostyler.rules[0])
          : 2,
        widthUnits: "pixels",
        opacity,
      } as any);

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: table,
        getFillColor: buildArrowColorAccessor(geostyler, (r) =>
          r ? getFillColorFromRule(r) : [0, 128, 255, 100],
          [0, 128, 255, 100],
        ),
        getLineColor: buildArrowColorAccessor(geostyler, (r) =>
          r ? getOutlineColorFromRule(r) : [0, 0, 0, 200],
          [0, 0, 0, 200],
        ),
        getLineWidth: geostyler.rules[0]
          ? getOutlineWidthFromRule(geostyler.rules[0])
          : 1,
        lineWidthUnits: "pixels",
        filled: true,
        stroked: true,
        opacity,
      } as any);

    default:
      throw new Error(
        `Unknown geometry type "${geometryType}" for layer "${config.id}"`,
      );
  }
}

export function createMVTLayer(config: LayerConfig): Layer {
  const { style, geostyler } = config;

  // If GeoStyler rules are defined, use conditional styling
  if (geostyler && geostyler.rules.length > 0) {
    return createStyledMVTLayer(config, geostyler);
  }

  // Fallback to legacy flat style
  return new MVTLayer({
    id: config.id,
    data: config.source,
    minZoom: 0,
    maxZoom: 14,
    getFillColor: toColor(style.color, [0, 128, 255, 100]),
    getLineColor: toColor(style.color, [0, 128, 255, 200]),
    getLineWidth: style.lineWidth ?? 1,
    lineWidthUnits: "pixels",
    getPointRadius: style.radius ?? 5,
    pointRadiusUnits: "pixels",
    filled: style.filled ?? true,
    stroked: style.stroked ?? true,
    opacity: style.opacity ?? 1,
  });
}

function createStyledMVTLayer(
  config: LayerConfig,
  geostyler: GeoStylerStyle,
): Layer {
  const opacity = getOpacityFromStyle(geostyler);

  return new MVTLayer({
    id: config.id,
    data: config.source,
    minZoom: 0,
    maxZoom: 14,
    getFillColor: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched ? getFillColorFromRule(matched) : [0, 128, 255, 100];
    },
    getLineColor: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched ? getOutlineColorFromRule(matched) : [0, 0, 0, 200];
    },
    getLineWidth: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched ? getOutlineWidthFromRule(matched) : 1;
    },
    getPointRadius: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched ? getMarkRadiusFromRule(matched) : 5;
    },
    lineWidthUnits: "pixels" as const,
    pointRadiusUnits: "pixels" as const,
    filled: true,
    stroked: true,
    opacity,
  });
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
