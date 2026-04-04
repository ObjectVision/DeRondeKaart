import type { Color } from "@deck.gl/core";
import type {
  GeoStylerFilter,
  GeoStylerRule,
  GeoStylerStyle,
  GeoStylerSymbolizer,
  FillSymbolizer,
  LineSymbolizer,
  MarkSymbolizer,
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

  // Comparison filters: [op, property, value]
  const propName = filter[1] as string;
  const expected = filter[2];
  const actual = properties[propName];

  switch (op) {
    case "==": return actual == expected; // eslint-disable-line eqeqeq
    case "!=": return actual != expected; // eslint-disable-line eqeqeq
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

/** Get opacity from the first symbolizer of any kind */
export function getOpacityFromStyle(style: GeoStylerStyle): number {
  if (style.rules.length === 0) return 1;
  const sym = style.rules[0].symbolizers[0];
  if (!sym) return 1;
  if ("opacity" in sym && sym.opacity !== undefined) return sym.opacity;
  return 1;
}
