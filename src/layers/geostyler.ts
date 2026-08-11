/**
 * RGBA tuple, 0–255 per channel. Alpha is optional (defaults to opaque at the
 * point of use). Previously deck.gl's `Color`; kept as the shared shape for
 * the flat `LayerStyle` colors that layers.json still uses.
 */
export type Color = [number, number, number] | [number, number, number, number];
import type {
  GeoStylerFilter,
  GeoStylerRule,
  GeoStylerStyle,
  FillSymbolizer,
  IconSymbolizer,
} from "./types";

/** Parse a CSS hex color string to a deck.gl RGBA color */
function hexToColor(hex: string, defaultAlpha = 255): Color {
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
  const sym = rule.symbolizers?.find((s) => s.kind === "Fill") as FillSymbolizer | undefined;
  if (sym?.color) return hexToColor(sym.color);
  return [0, 128, 255, 100];
}

/** The first Icon symbolizer of a rule, if any (point icon symbology). */
export function getIconFromRule(rule: GeoStylerRule): IconSymbolizer | undefined {
  return rule.symbolizers?.find((s) => s.kind === "Icon") as IconSymbolizer | undefined;
}
