import type { Layer, Color } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import { Table } from "apache-arrow";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-layers";
import type { LayerConfig, GeoStylerStyle, GeoStylerRule } from "./types";
import {
  getFillColorFromRule,
  getOutlineColorFromRule,
  getOutlineWidthFromRule,
  getLineColorFromRule,
  getLineWidthFromRule,
  getMarkColorFromRule,
  getMarkRadiusFromRule,
  getOpacityFromStyle,
  matchRule,
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

function buildArrowRuleColorAccessor(
  style: GeoStylerStyle,
  rule: GeoStylerRule,
  extractor: (rule: GeoStylerRule) => Color,
) {
  // Pre-extract all field names referenced in filters
  const filterFields = new Set<string>();
  for (const r of style.rules) {
    if (r.filter) {
      extractFilterFields(r.filter).forEach((f) => filterFields.add(f));
    }
  }
  const fields = Array.from(filterFields);

  return (info: { index: number; data: { data: { getChild: (name: string) => { get: (i: number) => unknown } | null } } }) => {
    const batch = info.data.data;
    const props: Record<string, unknown> = {};

    for (const field of fields) {
      const col = batch.getChild(field);
      if (col) props[field] = col.get(info.index);
    }

    const matched = matchRule(style, props);
    if (!matched || matched.name !== rule.name) return TRANSPARENT;
    return extractor(matched);
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

/**
 * Create deck.gl layers for a GeoArrow/Parquet source.
 * Returns one layer per GeoStyler rule (child layers), or a single layer if no geostyler.
 */
export function createGeoArrowLayers(
  config: LayerConfig,
  table: Table,
  batchIndex: number,
  beforeId?: string,
): Layer[] {
  const baseId = `${config.id}-batch-${batchIndex}`;
  const { style, geostyler } = config;
  const geometryType = config.geometryType ?? detectGeometryType(table);

  if (geostyler && geostyler.rules.length > 0) {
    return geostyler.rules.map((rule) =>
      createRuleGeoArrowLayer(`${baseId}-${rule.name}`, config, table, geometryType, geostyler, rule, beforeId),
    );
  }

  // Single layer for legacy flat style
  switch (geometryType) {
    case "point":
      return [new GeoArrowScatterplotLayer({
        id: baseId,
        data: table,
        pickable: true,
        getFillColor: toColor(style.color, [0, 128, 255, 200]),
        getRadius: style.radius ?? 5,
        radiusUnits: "pixels",
        opacity: style.opacity ?? 1,
        beforeId,
      })];

    case "line":
      return [new GeoArrowPathLayer({
        id: baseId,
        data: table,
        pickable: true,
        getColor: toColor(style.color, [0, 128, 255, 200]),
        getWidth: style.lineWidth ?? 2,
        widthUnits: "pixels",
        opacity: style.opacity ?? 1,
        beforeId,
      })];

    case "polygon":
      return [new GeoArrowPolygonLayer({
        id: baseId,
        data: table,
        pickable: true,
        getFillColor: toColor(style.color, [0, 128, 255, 100]),
        getLineColor: toColor(style.color, [0, 128, 255, 200]),
        getLineWidth: style.lineWidth ?? 1,
        lineWidthUnits: "pixels",
        filled: style.filled ?? true,
        stroked: style.stroked ?? true,
        opacity: style.opacity ?? 1,
        beforeId,
      })];

    default:
      throw new Error(
        `Unknown geometry type "${geometryType}" for layer "${config.id}"`,
      );
  }
}

/** Create a single GeoArrow layer for one specific GeoStyler rule */
function createRuleGeoArrowLayer(
  layerId: string,
  config: LayerConfig,
  table: Table,
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
        data: table,
        pickable: true,
        getFillColor: buildArrowRuleColorAccessor(geostyler, rule, getMarkColorFromRule),
        getRadius: getMarkRadiusFromRule(rule),
        radiusUnits: "pixels",
        opacity,
        beforeId,
      } as any);

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: table,
        pickable: true,
        getColor: buildArrowRuleColorAccessor(geostyler, rule, getLineColorFromRule),
        getWidth: getLineWidthFromRule(rule),
        widthUnits: "pixels",
        opacity,
        beforeId,
      } as any);

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: table,
        pickable: true,
        getFillColor: buildArrowRuleColorAccessor(geostyler, rule, getFillColorFromRule),
        getLineColor: buildArrowRuleColorAccessor(geostyler, rule, getOutlineColorFromRule),
        getLineWidth: getOutlineWidthFromRule(rule),
        lineWidthUnits: "pixels",
        filled: true,
        stroked: true,
        opacity,
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
