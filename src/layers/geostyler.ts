import type { Color } from "@deck.gl/core";
import type {
  GeoStylerFilter,
  GeoStylerRule,
  GeoStylerStyle,
  FillSymbolizer,
  LineSymbolizer,
  MarkSymbolizer,
  IconSymbolizer,
} from "./types";

/** Parse a CSS hex color string to a deck.gl RGBA color */
export function hexToColor(hex: string, defaultAlpha = 255): Color {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.substring(6, 8), 16) : defaultAlpha;
  return [r, g, b, a];
}

/** Evaluate a GeoStyler filter against a feature's properties */
export function evaluateFilter(
  filter: GeoStylerFilter,
  properties: Record<string, unknown>,
): boolean {
  const op = filter[0];

  // Combination filters
  if (op === "&&") {
    return (filter as unknown[]).slice(1).every((f) =>
      evaluateFilter(f as GeoStylerFilter, properties),
    );
  }
  if (op === "||") {
    return (filter as unknown[]).slice(1).some((f) =>
      evaluateFilter(f as GeoStylerFilter, properties),
    );
  }
  if (op === "!") {
    return !evaluateFilter(filter[1] as GeoStylerFilter, properties);
  }

  // Presence: ["has", property]. Distinct from `== ""` — an unset attribute is
  // absent from the properties bag entirely, which no comparison can detect.
  if (op === "has") {
    const value = properties[filter[1] as string];
    return value !== undefined && value !== null;
  }

  // Comparison filters: [op, property, value]
  const propName = filter[1] as string;
  const expected = filter[2];
  const actual = properties[propName];

  switch (op) {
    // Loose comparison is deliberate: geostyler filter values arrive from JSON
    // as strings/numbers interchangeably (e.g. class "3" vs 3).
    case "==": return actual == expected;
    case "!=": return actual != expected;
    case "<":  return (actual as number) < (expected as number);
    case "<=": return (actual as number) <= (expected as number);
    case ">":  return (actual as number) > (expected as number);
    case ">=": return (actual as number) >= (expected as number);
    default:   return false;
  }
}

/** Find the first matching rule for a feature, or return undefined */
export function matchRule(
  style: GeoStylerStyle,
  properties: Record<string, unknown>,
): GeoStylerRule | undefined {
  for (const rule of style.rules) {
    if (!rule.filter || evaluateFilter(rule.filter, properties)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Whether a feature is "kept" by a layer's geostyler rules — i.e. it matches at
 * least one rule. A layer WITHOUT geostyler rules keeps every feature (returns
 * true). Used to make rule-filtered features non-interactive: features rendered
 * transparent by the rule accessors (no matching rule) should not be pickable,
 * mirroring a real row-drop filter.
 */
export function featureMatchesGeostyler(
  style: GeoStylerStyle | undefined,
  properties: Record<string, unknown>,
): boolean {
  if (!style || style.rules.length === 0) return true;
  return matchRule(style, properties) !== undefined;
}

/** Extract fill color from the first Fill symbolizer in a rule */
export function getFillColorFromRule(rule: GeoStylerRule): Color {
  const sym = rule.symbolizers.find((s) => s.kind === "Fill") as FillSymbolizer | undefined;
  if (sym?.color) return hexToColor(sym.color);
  return [0, 128, 255, 100];
}

/** Extract outline color from the first Fill symbolizer in a rule */
export function getOutlineColorFromRule(rule: GeoStylerRule): Color {
  const sym = rule.symbolizers.find((s) => s.kind === "Fill") as FillSymbolizer | undefined;
  if (sym?.outlineColor) {
    const alpha = sym.outlineOpacity !== undefined ? Math.round(sym.outlineOpacity * 255) : 255;
    return hexToColor(sym.outlineColor, alpha);
  }
  return [0, 0, 0, 200];
}

/** Extract outline width from the first Fill symbolizer */
export function getOutlineWidthFromRule(rule: GeoStylerRule): number {
  const sym = rule.symbolizers.find((s) => s.kind === "Fill") as FillSymbolizer | undefined;
  return sym?.outlineWidth ?? 1;
}

/** Extract line color from the first Line symbolizer */
export function getLineColorFromRule(rule: GeoStylerRule): Color {
  const sym = rule.symbolizers.find((s) => s.kind === "Line") as LineSymbolizer | undefined;
  if (sym?.color) return hexToColor(sym.color);
  return [0, 128, 255, 200];
}

/** Extract line width from the first Line symbolizer */
export function getLineWidthFromRule(rule: GeoStylerRule): number {
  const sym = rule.symbolizers.find((s) => s.kind === "Line") as LineSymbolizer | undefined;
  return sym?.width ?? 2;
}

/** Extract mark color from the first Mark symbolizer */
export function getMarkColorFromRule(rule: GeoStylerRule): Color {
  const sym = rule.symbolizers.find((s) => s.kind === "Mark") as MarkSymbolizer | undefined;
  if (sym?.color) return hexToColor(sym.color);
  return [0, 128, 255, 200];
}

/** Extract mark radius from the first Mark symbolizer */
export function getMarkRadiusFromRule(rule: GeoStylerRule): number {
  const sym = rule.symbolizers.find((s) => s.kind === "Mark") as MarkSymbolizer | undefined;
  return sym?.radius ?? 5;
}

/** The first Icon symbolizer of a rule, if any (point icon symbology). */
export function getIconFromRule(rule: GeoStylerRule): IconSymbolizer | undefined {
  return rule.symbolizers.find((s) => s.kind === "Icon") as IconSymbolizer | undefined;
}

/** Get opacity from the first symbolizer of any kind */
export function getOpacityFromStyle(style: GeoStylerStyle): number {
  if (style.rules.length === 0) return 1;
  const sym = style.rules[0].symbolizers[0];
  if (!sym) return 1;
  if ("opacity" in sym && sym.opacity !== undefined) return sym.opacity;
  return 1;
}
