import type { LayerConfig, GeoStylerRule, GeoStylerFilter, FillSymbolizer, LineSymbolizer, MarkSymbolizer } from "./types";

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

interface MvtLayerDef {
  id: string;
  ruleName: string;
  type: "fill" | "line" | "circle";
  filter?: unknown[];
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
}

/**
 * Build MapLibre layer definitions from a LayerConfig.
 * Returns one layer per GeoStyler rule, or a single layer for flat style.
 */
export function buildMvtLayerDefs(config: LayerConfig): MvtLayerDef[] {
  const { geostyler, style } = config;

  if (geostyler && geostyler.rules.length > 0) {
    return geostyler.rules.map((rule) => buildRuleLayerDef(config, rule));
  }

  // Flat style — single fill layer
  const [r, g, b, a] = style.color ?? [0, 128, 255, 100];
  const opacity = style.opacity ?? 1;

  return [{
    id: `mvt-layer-${config.id}`,
    ruleName: "",
    type: "fill",
    paint: {
      "fill-color": `rgba(${r}, ${g}, ${b}, ${(a ?? 200) / 255})`,
      "fill-opacity": opacity,
      "fill-outline-color": `rgba(${r}, ${g}, ${b}, ${(a ?? 200) / 255})`,
    },
    layout: {},
  }];
}

function buildRuleLayerDef(config: LayerConfig, rule: GeoStylerRule): MvtLayerDef {
  const sym = rule.symbolizers[0];
  if (!sym) {
    return {
      id: `mvt-layer-${config.id}-${rule.name}`,
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
    default:
      return buildFillLayerDef(config, rule, sym as FillSymbolizer);
  }
}

function buildFillLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: FillSymbolizer): MvtLayerDef {
  const fillColor = resolveColor(sym.color, "#0080ff");
  const outlineColor = resolveColor(sym.outlineColor, "#000000");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const outlineWidth = sym.outlineWidth ?? 1;
  const outlineOpacity = sym.outlineOpacity ?? 1;

  const def: MvtLayerDef = {
    id: `mvt-layer-${config.id}-${rule.name}`,
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

function buildLineLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: LineSymbolizer): MvtLayerDef {
  const lineColor = resolveColor(sym.color, "#0080ff");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const lineWidth = sym.width ?? 2;

  const def: MvtLayerDef = {
    id: `mvt-layer-${config.id}-${rule.name}`,
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

function buildCircleLayerDef(config: LayerConfig, rule: GeoStylerRule, sym: MarkSymbolizer): MvtLayerDef {
  const circleColor = resolveColor(sym.color, "#0080ff");
  const opacity = config.style.opacity ?? sym.opacity ?? 1;
  const radius = sym.radius ?? 5;

  const def: MvtLayerDef = {
    id: `mvt-layer-${config.id}-${rule.name}`,
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
