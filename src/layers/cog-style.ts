import type { GeoStylerStyle } from "./types";
import { matchRule, getFillColorFromRule } from "./geostyler";

/**
 * Per-pixel color function for `@geomatico/maplibre-cog-protocol`'s
 * `setColorFunction`. The protocol calls this for every pixel with `pixel` being
 * that pixel's band values (`pixel[0]` = band0, `pixel[1]` = band1, …) and
 * `color` an RGBA slot (0–255) to write into. `metadata.noData` (when present)
 * is the source nodata value.
 *
 * We expose the bands as `band0`, `band1`, … and run them through the SAME
 * GeoStyler engine used for vector layers (`matchRule`), so a COG band is styled
 * with the identical rule syntax as geoparquet — e.g.
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

  return (pixel, color, metadata) => {
    // nodata → transparent
    if (metadata?.noData !== undefined && pixel[0] === metadata.noData) {
      color[0] = color[1] = color[2] = color[3] = 0;
      return;
    }

    for (let b = 0; b < pixel.length; b++) {
      properties[`band${b}`] = pixel[b];
    }

    const rule = matchRule(style, properties);
    if (!rule) {
      // unmatched class → transparent
      color[0] = color[1] = color[2] = color[3] = 0;
      return;
    }

    const [r, g, b, a] = getFillColorFromRule(rule);
    color[0] = r;
    color[1] = g;
    color[2] = b;
    color[3] = a ?? 255;
  };
}
