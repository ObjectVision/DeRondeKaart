import type { LayerEntry } from "@/hooks/use-map-layers";
import type { GeoStylerRule, GeometryType, LayerStyle } from "@/layers/types";
import { compositeLegendRules } from "@/layers/composite-manager";

/**
 * Legend swatch/label helpers shared by the on-map Legend component, the
 * share-dialog preview mini-legend, and the PNG-export canvas compositor.
 */

export function colorToCSS(
  color?: [number, number, number] | [number, number, number, number],
): string {
  if (!color) return "rgb(0, 128, 255)";
  const [r, g, b, a] = color;
  return a !== undefined
    ? `rgba(${r}, ${g}, ${b}, ${a / 255})`
    : `rgb(${r}, ${g}, ${b})`;
}

/**
 * What a legend swatch should draw, per symbolizer kind — so a line layer shows
 * a line, a point layer a circle, an icon layer its actual SVG, instead of the
 * one-flat-square-for-everything the legend used to render. Consumed by the
 * shared <Swatch/> component (HTML surfaces) and the PNG-export canvas drawing.
 */
export type SwatchSpec =
  /** `outline` undefined → the map draws no outline; swatch uses a neutral hairline. */
  | { kind: "fill"; color: string; outline?: string }
  /** `width` in map px. */
  | { kind: "line"; color: string; width: number }
  /** `radius` in map px, as MapLibre circle-radius / deck point radius. */
  | { kind: "circle"; color: string; radius: number; strokeColor?: string; strokeWidth?: number }
  | { kind: "icon"; url: string; tint?: string };

const DEFAULT_COLOR = "#0080ff";

/** Resolve the CSS color names the configs actually use (same set as mvt-style). */
function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color === "black") return "#000000";
  if (color === "white") return "#ffffff";
  return color;
}

/**
 * Swatch spec for a GeoStyler rule, from its first symbolizer.
 *
 * Shows the symbolizer's DECLARED colour, which is not always the colour the
 * map paints: a rule's raw `paint` override (RawStyleOverrides) wins on the map
 * but is deliberately ignored here. An override is typically an expression —
 * `["interpolate", …]` over a data value has no single colour to draw — so
 * reducing one to a swatch is not well defined. A rule using overrides should
 * keep its symbolizer's colour roughly representative, or carry no symbolizer
 * at all and accept the neutral default below.
 */
export function ruleSwatchSpec(rule: GeoStylerRule): SwatchSpec {
  const sym = rule.symbolizers[0];
  if (!sym) return { kind: "fill", color: DEFAULT_COLOR };

  switch (sym.kind) {
    case "Fill": {
      // Match buildFillLayerDef: outlineWidth/Opacity 0 → no outline drawn on
      // the map. The swatch then falls back to a neutral hairline (undefined)
      // so pale fills stay visible against the white legend panel.
      const hasOutline = (sym.outlineWidth ?? 1) !== 0 && (sym.outlineOpacity ?? 1) !== 0;
      return {
        kind: "fill",
        color: sym.color ?? DEFAULT_COLOR,
        outline: hasOutline ? resolveColor(sym.outlineColor, "#000000") : undefined,
      };
    }
    case "Line":
      return { kind: "line", color: sym.color ?? DEFAULT_COLOR, width: sym.width ?? 1 };
    case "Mark":
      return {
        kind: "circle",
        color: sym.color ?? DEFAULT_COLOR,
        radius: sym.radius ?? 5,
        strokeColor: sym.strokeColor ? resolveColor(sym.strokeColor, "#000000") : undefined,
        strokeWidth: sym.strokeWidth,
      };
    case "Icon":
      return { kind: "icon", url: sym.image, tint: sym.color };
    default:
      return { kind: "fill", color: DEFAULT_COLOR };
  }
}

/**
 * Swatch spec for a layer without GeoStyler rules (legacy flat style), matched
 * to its geometry — so a boundary layer shows a line rather than the empty
 * square its transparent `color` would otherwise produce.
 */
export function styleSwatchSpec(style: LayerStyle, geometryType?: GeometryType): SwatchSpec {
  if (geometryType === "line") {
    return {
      kind: "line",
      // Same precedence as the map (mvt-style's `lineRgba ?? rgba`).
      color: colorToCSS(style.lineColor ?? style.color),
      width: style.lineWidth ?? 2,
    };
  }
  if (geometryType === "point") {
    return { kind: "circle", color: colorToCSS(style.color), radius: style.radius ?? 5 };
  }
  return { kind: "fill", color: colorToCSS(style.color) };
}

/** One flat legend row (swatch + label) for export rendering. */
export interface ExportLegendItem {
  /** Absent on heading rows (which render no swatch). */
  spec?: SwatchSpec;
  label: string;
  /** True for a layer heading row above its per-rule class rows. */
  heading?: boolean;
}

/**
 * Flatten the visible legend content of a map side into plain rows: one row
 * per single-rule/flat-style layer; for multi-rule layers a heading row (the
 * layer name, no swatch semantics beyond the first rule) followed by one row
 * per visible rule. Mirrors the Legend component's display logic (≥2 rules →
 * per-rule class list; excludeFromLegend and hidden layers/rules skipped).
 */
export function legendItemsForEntries(
  entries: LayerEntry[],
  hiddenIds: Set<string>,
  hiddenRules: globalThis.Map<string, Set<string>>,
): ExportLegendItem[] {
  const items: ExportLegendItem[] = [];
  for (const { config } of entries) {
    if (config.excludeFromLegend) continue;
    if (hiddenIds.has(config.id)) continue;

    // Own geostyler rules, or — for a composite without one — each child's
    // rules in order, keyed per child (see compositeLegendRules).
    const ownRules = config.geostyler?.rules;
    const rules: { rule: GeoStylerRule; key: string }[] = ownRules?.length
      ? ownRules.map((rule) => ({ rule, key: rule.name }))
      : compositeLegendRules(config).map((ref) => ({ rule: ref.rule, key: ref.key }));

    if (rules.length > 1) {
      items.push({ label: config.name, heading: true });
      const layerHidden = hiddenRules.get(config.id);
      for (const { rule, key } of rules) {
        if (layerHidden?.has(key)) continue;
        items.push({ spec: ruleSwatchSpec(rule), label: rule.name });
      }
    } else if (rules.length === 1) {
      items.push({ spec: ruleSwatchSpec(rules[0].rule), label: config.name });
    } else {
      items.push({ spec: styleSwatchSpec(config.style, config.geometryType), label: config.name });
    }
  }
  return items;
}
