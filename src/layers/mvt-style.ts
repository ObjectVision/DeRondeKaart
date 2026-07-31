import type { LayerConfig, GeoStylerRule, GeoStylerFilter, FillSymbolizer, LineSymbolizer, MarkSymbolizer, IconSymbolizer } from "./types";

/**
 * Convert a GeoStyler filter to a MapLibre expression.
 */
function filterToExpression(filter: GeoStylerFilter): unknown[] {
  const op = filter[0];

  if (op === "&&") {
    const subFilters = (filter as unknown[]).slice(1).map((f) => filterToExpression(f as GeoStylerFilter));
    return ["all", ...subFilters];
  }
  if (op === "||") {
    const subFilters = (filter as unknown[]).slice(1).map((f) => filterToExpression(f as GeoStylerFilter));
    return ["any", ...subFilters];
  }

  const propName = filter[1] as string;
  const value = filter[2];

  return [op, ["get", propName], value];
}

/** Resolve a CSS color name to hex (only for "black" / "white" commonly used) */
function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color === "black") return "#000000";
  if (color === "white") return "#ffffff";
  return color;
}

/**
 * Formats rendered as native MapLibre *vector* layers built from GeoStyler
 * rules (as opposed to deck.gl layers, or the COG raster path). These share
 * the `buildNativeLayerDefs` id scheme, so picking/hover/visibility/rule
 * toggling all treat them identically.
 */
export function isNativeVectorFormat(format: LayerConfig["format"]): boolean {
  return format === "mvt" || format === "pmtiles" || format === "flatgeobuf";
}

interface NativeLayerDef {
  id: string;
  ruleName: string;
  type: "fill" | "line" | "circle" | "symbol";
  filter?: unknown[];
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
}

/**
 * Sprite id an Icon symbolizer's image is registered under.
 *
 * Keyed on tint-ness as well as the URL: a tinted icon must be added to the
 * sprite as an SDF (only SDF images honour `icon-color`) and an SDF image
 * renders as a flat silhouette when drawn untinted, so the two variants of the
 * same URL cannot share one entry. The deck.gl path keys its icon atlas the
 * same way (`layer-factory.ts`, `mask: Boolean(icon.color)`).
 */
export function iconSpriteId(sym: IconSymbolizer): string {
  return `icon-${sym.image}${sym.color ? "#sdf" : ""}`;
}

/**
 * Native MapLibre layer ids are `<prefix><configId>[-<ruleName>]`. The prefix
 * is format-derived so MVT and FlatGeobuf layers never collide and each
 * format's pick/hover paths can recognize its own layers.
 */
function layerId(config: LayerConfig, ruleName?: string): string {
  const prefix =
    config.format === "flatgeobuf"
      ? "fgb-layer-"
      : config.format === "pmtiles"
        ? "pmtiles-layer-"
        : "mvt-layer-";
  return ruleName === undefined
    ? `${prefix}${config.id}`
    : `${prefix}${config.id}-${ruleName}`;
}

/**
 * Build native MapLibre layer definitions from a LayerConfig (MVT, PMTiles and
 * FlatGeobuf formats). Returns one layer per GeoStyler rule, or a single
 * layer for flat style.
 */
export function buildNativeLayerDefs(config: LayerConfig): NativeLayerDef[] {
  const { geostyler, style } = config;

  if (geostyler && geostyler.rules.length > 0) {
    return geostyler.rules.map((rule) => buildRuleLayerDef(config, rule));
  }

  // Flat style — single layer. MVT keeps its historical fill-only behavior;
  // flatgeobuf/pmtiles pick the layer type from the configured geometry type.
  const [r, g, b, a] = style.color ?? [0, 128, 255, 100];
  const opacity = style.opacity ?? 1;
  const rgba = `rgba(${r}, ${g}, ${b}, ${(a ?? 200) / 255})`;
  const typedFlatStyle = config.format === "flatgeobuf" || config.format === "pmtiles";

  if (typedFlatStyle && config.geometryType === "point") {
    return [{
      id: layerId(config),
      ruleName: "",
      type: "circle",
      paint: {
        "circle-color": rgba,
        "circle-opacity": opacity,
        "circle-radius": style.radius ?? 5,
      },
      layout: {},
    }];
  }
  if (typedFlatStyle && config.geometryType === "line") {
    return [{
      id: layerId(config),
      ruleName: "",
      type: "line",
      paint: {
        "line-color": rgba,
        "line-opacity": opacity,
        "line-width": style.lineWidth ?? 2,
      },
      layout: {},
    }];
  }

  return [{
    id: layerId(config),
    ruleName: "",
    type: "fill",
    paint: {
      "fill-color": rgba,
      "fill-opacity": opacity,
      "fill-outline-color": rgba,
    },
    layout: {},
  }];
}

function buildRuleLayerDef(config: LayerConfig, rule: GeoStylerRule): NativeLayerDef {
  const sym = rule.symbolizers[0];
  if (!sym) {
    return {
      id: layerId(config, rule.name),
      ruleName: rule.name,
      type: "fill",
      filter: rule.filter ? filterToExpression(rule.filter) : undefined,
      paint: {},
      layout: {},
    };
  }

  switch (sym.kind) {
    case "Fill":
      return buildFillLayerDef(config, rule, sym);
    case "Line":
      return buildLineLayerDef(config, rule, sym);
    case "Mark":
      return buildCircleLayerDef(config, rule, sym);
    case "Icon":
      return buildSymbolLayerDef(config, rule, sym);
    default:
      // Falling through to a fill layer renders NOTHING for point/line data,
      // and does so silently — which is exactly how the supermarkt Icon layer
      // stayed broken after it moved from parquet (deck.gl, which supports
      // Icon) to pmtiles. Say so rather than drawing an invisible layer.
      console.warn(
        `layers.json: layer "${config.id}" (${config.format}) uses symbolizer ` +
          `kind "${(sym as { kind?: string }).kind}", which the native vector-tile ` +
          `renderer does not support; falling back to a Fill layer`,
      );
      return buildFillLayerDef(config, rule, sym as unknown as FillSymbolizer);
  }
}

function buildFillLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: FillSymbolizer): NativeLayerDef {
  const fillColor = resolveColor(sym.color, "#0080ff");
  const outlineColor = resolveColor(sym.outlineColor, "#000000");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const outlineWidth = sym.outlineWidth ?? 1;
  const outlineOpacity = sym.outlineOpacity ?? 1;

  const def: NativeLayerDef = {
    id: layerId(config, rule.name),
    ruleName: rule.name,
    type: "fill",
    paint: {
      "fill-color": fillColor,
      "fill-opacity": opacity,
    },
    layout: {},
  };

  if (rule.filter) {
    def.filter = filterToExpression(rule.filter);
  }

  // fill-outline-color only works when fill-antialias is true (default) and line width is always 1px.
  // For outline width control we'd need a separate line layer, but for outlineWidth: 0 we just
  // set fill-outline-color to transparent.
  if (outlineWidth === 0 || outlineOpacity === 0) {
    def.paint["fill-outline-color"] = "transparent";
  } else {
    def.paint["fill-outline-color"] = outlineColor;
  }

  return def;
}

function buildLineLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: LineSymbolizer): NativeLayerDef {
  const lineColor = resolveColor(sym.color, "#0080ff");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const lineWidth = sym.width ?? 2;

  const def: NativeLayerDef = {
    id: layerId(config, rule.name),
    ruleName: rule.name,
    type: "line",
    paint: {
      "line-color": lineColor,
      "line-opacity": opacity,
      "line-width": lineWidth,
    },
    layout: {},
  };

  if (rule.filter) {
    def.filter = filterToExpression(rule.filter);
  }

  return def;
}

function buildCircleLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: MarkSymbolizer): NativeLayerDef {
  const circleColor = resolveColor(sym.color, "#0080ff");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const radius = sym.radius ?? 5;

  const def: NativeLayerDef = {
    id: layerId(config, rule.name),
    ruleName: rule.name,
    type: "circle",
    paint: {
      "circle-color": circleColor,
      "circle-opacity": opacity,
      "circle-radius": radius,
    },
    layout: {},
  };

  if (rule.filter) {
    def.filter = filterToExpression(rule.filter);
  }

  if (sym.strokeColor) {
    def.paint["circle-stroke-color"] = resolveColor(sym.strokeColor, "#000000");
    def.paint["circle-stroke-width"] = sym.strokeWidth ?? 1;
  }

  return def;
}

/**
 * Icon symbolizer -> MapLibre `symbol` layer.
 *
 * The image itself is registered in the map's sprite by the caller (see
 * `registerRuleIcons` in use-map-layers) under `iconSpriteId(sym)`, because
 * loading it is async while layer defs are built synchronously.
 */
function buildSymbolLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: IconSymbolizer): NativeLayerDef {
  const opacity = config.style.opacity ?? sym.opacity ?? 1;

  const def: NativeLayerDef = {
    id: layerId(config, rule.name),
    ruleName: rule.name,
    type: "symbol",
    paint: {
      "icon-opacity": opacity,
    },
    layout: {
      "icon-image": iconSpriteId(sym),
      // The sprite holds the image at its source pixel size, so scale to the
      // requested rendered size (`size` is a height in screen px, as in the
      // deck.gl icon path).
      "icon-size": sym.height ? (sym.size ?? sym.height) / sym.height : 1,
      // POI markers must all stay visible: MapLibre otherwise drops symbols
      // that collide, which thins them out heavily when zoomed out.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  };

  // Only SDF sprite entries honour icon-color; iconSpriteId() registers a
  // separate SDF entry whenever a tint is configured.
  if (sym.color) {
    def.paint["icon-color"] = resolveColor(sym.color, "#000000");
  }

  if (rule.filter) {
    def.filter = filterToExpression(rule.filter);
  }

  return def;
}
