import type { LayerEntry } from "@/hooks/use-map-layers";
import type { GeoStylerRule } from "@/layers/types";

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

/** Get the display color from the first symbolizer of a GeoStyler rule */
export function ruleSwatchColor(rule: GeoStylerRule): string {
  const sym = rule.symbolizers[0];
  if (!sym) return "rgb(0, 128, 255)";
  if (sym.kind === "Fill") return sym.color ?? "#0080ff";
  if (sym.kind === "Line") return sym.color ?? "#0080ff";
  if (sym.kind === "Mark") return sym.color ?? "#0080ff";
  return "#0080ff";
}

/** One flat legend row (swatch color + label) for export rendering. */
export interface ExportLegendItem {
  color: string;
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

    const rules = config.geostyler?.rules;
    if (rules && rules.length > 1) {
      items.push({ color: "", label: config.name, heading: true });
      const layerHidden = hiddenRules.get(config.id);
      for (const rule of rules) {
        if (layerHidden?.has(rule.name)) continue;
        items.push({ color: ruleSwatchColor(rule), label: rule.name });
      }
    } else if (rules && rules.length === 1) {
      items.push({ color: ruleSwatchColor(rules[0]), label: config.name });
    } else {
      items.push({ color: colorToCSS(config.style.color), label: config.name });
    }
  }
  return items;
}
