import type { Layer, Color } from "@deck.gl/core";
import { Table } from "apache-arrow";
import { MVTLayer } from "@deck.gl/geo-layers";
import {
  GeoArrowScatterplotLayer,
  GeoArrowPathLayer,
  GeoArrowPolygonLayer,
} from "@geoarrow/deck.gl-layers";
import type { LayerConfig, GeoStylerStyle, GeoStylerRule } from "./types";
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
): Layer[] {
  const baseId = `${config.id}-batch-${batchIndex}`;
  const { style, geostyler } = config;
  const geometryType = config.geometryType ?? detectGeometryType(table);

  if (geostyler && geostyler.rules.length > 0) {
    return geostyler.rules.map((rule) =>
      createRuleGeoArrowLayer(`${baseId}-${rule.name}`, config, table, geometryType, geostyler, rule),
    );
  }

  // Single layer for legacy flat style
  switch (geometryType) {
    case "point":
      return [new GeoArrowScatterplotLayer({
        id: baseId,
        data: table,
        getFillColor: toColor(style.color, [0, 128, 255, 200]),
        getRadius: style.radius ?? 5,
        radiusUnits: "pixels",
        opacity: style.opacity ?? 1,
      })];

    case "line":
      return [new GeoArrowPathLayer({
        id: baseId,
        data: table,
        getColor: toColor(style.color, [0, 128, 255, 200]),
        getWidth: style.lineWidth ?? 2,
        widthUnits: "pixels",
        opacity: style.opacity ?? 1,
      })];

    case "polygon":
      return [new GeoArrowPolygonLayer({
        id: baseId,
        data: table,
        getFillColor: toColor(style.color, [0, 128, 255, 100]),
        getLineColor: toColor(style.color, [0, 128, 255, 200]),
        getLineWidth: style.lineWidth ?? 1,
        lineWidthUnits: "pixels",
        filled: style.filled ?? true,
        stroked: style.stroked ?? true,
        opacity: style.opacity ?? 1,
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
): Layer {
  const opacity = getOpacityFromStyle(geostyler);

  switch (geometryType) {
    case "point":
      return new GeoArrowScatterplotLayer({
        id: layerId,
        data: table,
        getFillColor: buildArrowRuleColorAccessor(geostyler, rule, getMarkColorFromRule),
        getRadius: getMarkRadiusFromRule(rule),
        radiusUnits: "pixels",
        opacity,
      } as any);

    case "line":
      return new GeoArrowPathLayer({
        id: layerId,
        data: table,
        getColor: buildArrowRuleColorAccessor(geostyler, rule, getLineColorFromRule),
        getWidth: getLineWidthFromRule(rule),
        widthUnits: "pixels",
        opacity,
      } as any);

    case "polygon":
      return new GeoArrowPolygonLayer({
        id: layerId,
        data: table,
        getFillColor: buildArrowRuleColorAccessor(geostyler, rule, getFillColorFromRule),
        getLineColor: buildArrowRuleColorAccessor(geostyler, rule, getOutlineColorFromRule),
        getLineWidth: getOutlineWidthFromRule(rule),
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

/**
 * Create deck.gl layers for an MVT source.
 * Returns one layer per GeoStyler rule (child layers), or a single layer if no geostyler.
 */
export function createMVTLayers(config: LayerConfig): Layer[] {
  const { style, geostyler } = config;

  if (geostyler && geostyler.rules.length > 0) {
    return geostyler.rules.map((rule) =>
      createRuleMVTLayer(config, geostyler, rule),
    );
  }

  return [new MVTLayer({
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
  })];
}

/** Create a single MVT layer for one specific GeoStyler rule */
function createRuleMVTLayer(
  config: LayerConfig,
  geostyler: GeoStylerStyle,
  rule: GeoStylerRule,
): Layer {
  const opacity = getOpacityFromStyle(geostyler);

  return new MVTLayer({
    id: `${config.id}-${rule.name}`,
    data: config.source,
    minZoom: 0,
    maxZoom: 14,
    getFillColor: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      if (!matched || matched.name !== rule.name) return TRANSPARENT;
      return getFillColorFromRule(matched);
    },
    getLineColor: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      if (!matched || matched.name !== rule.name) return TRANSPARENT;
      return getOutlineColorFromRule(matched);
    },
    getLineWidth: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched && matched.name === rule.name ? getOutlineWidthFromRule(matched) : 0;
    },
    getPointRadius: (feature: { properties: Record<string, unknown> }) => {
      const matched = matchRule(geostyler, feature.properties);
      return matched && matched.name === rule.name ? getMarkRadiusFromRule(matched) : 0;
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
