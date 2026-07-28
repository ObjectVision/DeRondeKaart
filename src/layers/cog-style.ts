import type { GeoStylerStyle } from "./types";
import { evaluateFilter, getFillColorFromRule } from "./geostyler";

/**
 * Per-pixel color function for `@geomatico/maplibre-cog-protocol`'s
 * `setColorFunction`. The protocol calls this for every pixel with `pixel` being
 * that pixel's band values (`pixel[0]` = band0, `pixel[1]` = band1, …) and
 * `color` an RGBA slot (0–255) to write into. `metadata.noData` (when present)
 * is the source nodata value.
 *
 * We expose the bands as `band0`, `band1`, … and run them through the SAME
 * GeoStyler engine used for vector layers (`matchRule`), so a COG band is styled
 * with the identical rule syntax as parquet vector layers — e.g.
 * `["&&", [">=", "band0", 11], ["<", "band0", 25]]`.
 *
 * Pixels matching no rule, and nodata pixels, are written fully transparent.
 */
type CogColorFunction = (
  pixel: ArrayLike<number>,
  color: Uint8ClampedArray,
  metadata: { noData?: number },
) => void;

export function buildCogColorFunction(style: GeoStylerStyle): CogColorFunction {
  // Reused across every pixel — mutated in place to avoid per-pixel allocation.
  const properties: Record<string, number> = {};

  // Rule colors are constant, so resolve them (symbolizer lookup + hex parse)
  // once here, index-aligned with style.rules — not per pixel.
  const rules = style.rules;
  const ruleColors = rules.map((rule) => {
    const [r, g, b, a] = getFillColorFromRule(rule);
    return [r, g, b, a ?? 255] as const;
  });

  return (pixel, color, metadata) => {
    // nodata → transparent
    if (metadata?.noData !== undefined && pixel[0] === metadata.noData) {
      color[0] = color[1] = color[2] = color[3] = 0;
      return;
    }

    for (let b = 0; b < pixel.length; b++) {
      properties[`band${b}`] = pixel[b];
    }

    // First matching rule wins (same semantics as matchRule), but resolve to an
    // index into the precomputed color table.
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule.filter || evaluateFilter(rule.filter, properties)) {
        const c = ruleColors[i];
        color[0] = c[0];
        color[1] = c[1];
        color[2] = c[2];
        color[3] = c[3];
        return;
      }
    }

    // unmatched class → transparent
    color[0] = color[1] = color[2] = color[3] = 0;
  };
}
