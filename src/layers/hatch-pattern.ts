/**
 * Diagonal hatch fill: the one geometry definition the map, the legend swatch
 * and the PNG export all derive from, so the three cannot drift apart.
 *
 * MapLibre draws a hatch via `fill-pattern`, which needs an image registered in
 * the map's sprite. Unlike an Icon symbolizer's image, this one is DRAWN rather
 * than fetched — `renderHatchTile` is synchronous, which is what lets hatched
 * layers stay on the synchronous add path in use-map-layers.ts. Deferring an
 * add by even a microtask reorders it against the z-order anchors (see the note
 * above `registerRuleIcons`), so a hatch must never need an await.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { LayerConfig } from "./types";

/** Stripe/background colours of a hatch, both fully resolved. */
export interface HatchColors {
  color: string;
  background: string;
}

/**
 * Hatch geometry, in logical px.
 *
 * `size` is the tile's edge length — the AXIS-ALIGNED repeat. Because the
 * stripes run at 45°, the perpendicular distance between them is
 * `size / √2` (see `HATCH_PERIOD`), and exactly one stripe period fits the
 * tile. That relationship is what makes the pattern seamless, so `size` cannot
 * be changed independently of the angle.
 *
 * `stripe` is the drawn line width: thin lines with generous white between
 * them, per the design.
 */
export const HATCH = {
  size: 8,
  stripe: 1,
  /** Degrees, clockwise from horizontal. 45 = the "/" direction. */
  angle: 45,
} as const;

/**
 * Perpendicular distance between stripe centres — the spacing the eye actually
 * reads, and the period the CSS swatch must use to match the map's tile.
 */
export const HATCH_PERIOD = HATCH.size / Math.SQRT2;

/**
 * Supersampling factor for the sprite tile: the image is drawn at this many
 * device px per logical px and registered with a matching `pixelRatio`, so the
 * diagonals stay smooth without changing the drawn size.
 */
export const HATCH_SCALE = 2;

/** Red on white, matching the design this was introduced for. */
export const HATCH_DEFAULTS: HatchColors = {
  color: "#E02B27",
  background: "#ffffff",
};

/**
 * Resolve a symbolizer's `hatch` field (`true` or a partial override) to full
 * colours. `undefined` in, `undefined` out — callers use that to test opt-in.
 */
export function resolveHatch(
  hatch: boolean | { color?: string; background?: string } | undefined,
): HatchColors | undefined {
  if (!hatch) return undefined;
  if (hatch === true) return HATCH_DEFAULTS;
  return {
    color: hatch.color ?? HATCH_DEFAULTS.color,
    background: hatch.background ?? HATCH_DEFAULTS.background,
  };
}

/**
 * Sprite id for a hatch, keyed on its colours so every layer sharing a colour
 * pair shares one sprite entry (189 layers do). Same idea as `iconSpriteId`.
 */
export function hatchPatternId(colors: HatchColors): string {
  return `hatch-${colors.color}-${colors.background}`;
}

/**
 * Draw one seamlessly-tiling hatch tile.
 *
 * `scale` supersamples: the canvas is `size * scale` px and the result is
 * registered with `{ pixelRatio: scale }`, so MapLibre still treats it as a
 * `size`-px logical tile but has the extra pixels to keep the diagonals smooth
 * (the trick `loadIconBitmap` documents for icons).
 *
 * Seamlessness is the whole difficulty, and it is a constraint on the GEOMETRY,
 * not something extra drawing can paper over. A 45° stripe leaves the tile
 * through a different edge than it entered, so the pattern only joins up if the
 * stripes' period lines up with the tile: crossing the tile's full width must
 * advance by a whole number of stripes. At 45° the perpendicular distance
 * between stripes is therefore `size / √2` (one period per tile), which is why
 * `size` is documented as the AXIS-ALIGNED repeat, not the perpendicular gap.
 *
 * Drawing it as two straight segments per stripe — the main diagonal plus the
 * copy shifted by one tile — is what makes each line continue exactly where its
 * neighbour left off. A stripe spaced by anything other than that period breaks
 * at every tile boundary, which reads as dashes rather than lines.
 */
export function renderHatchTile(colors: HatchColors, scale = HATCH_SCALE): ImageData {
  const px = HATCH.size * scale;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d context to draw the hatch tile");

  // Opaque background: the hatch masks whatever is under it, rather than
  // letting the basemap show between the stripes.
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, px, px);

  // Lines run "/" (bottom-left to top-right), spaced HATCH_PERIOD apart along
  // their normal. Each is drawn at every whole-tile offset that can reach the
  // tile, and each spans well beyond it, so the segments meeting at the corners
  // are all present — the pattern is then exactly the infinite hatch restricted
  // to the tile, which is what makes it join up on all four edges.
  ctx.strokeStyle = colors.color;
  ctx.lineWidth = HATCH.stripe * scale;
  ctx.lineCap = "butt";

  // A "/" line through (c, 0) is x + y = c. Stepping c by the diagonal spacing
  // (period * √2 in x/y terms) walks from one stripe to the next; the tile needs
  // c from 0 to 2*px, plus one on each side for the corner segments.
  const cStep = HATCH_PERIOD * Math.SQRT2 * scale;
  for (let c = -cStep; c <= 2 * px + cStep; c += cStep) {
    ctx.beginPath();
    ctx.moveTo(c + px, -px);
    ctx.lineTo(c - px, px);
    ctx.stroke();
  }

  return ctx.getImageData(0, 0, px, px);
}

/**
 * Register the hatch image every hatched rule of this config needs.
 *
 * Synchronous by design (see the module note): callers must be able to run this
 * immediately before `addLayer` without deferring the add.
 *
 * `hasImage` is re-checked on every call rather than cached, for the same reason
 * `registerRuleIcons` does: a basemap swap wipes the sprite, and `addImage`
 * throws on a duplicate id. Since `syncImperativeLayers` re-adds layers after
 * `styledata`, that re-check is what restores the pattern after a swap.
 */
export function ensureHatchImages(map: MapLibreMap, config: LayerConfig): void {
  for (const rule of config.geostyler?.rules ?? []) {
    const sym = rule.symbolizers[0];
    if (!sym || sym.kind !== "Fill") continue;
    const hatch = resolveHatch(sym.hatch);
    if (!hatch) continue;

    const id = hatchPatternId(hatch);
    if (map.hasImage(id)) continue;
    map.addImage(id, renderHatchTile(hatch), { pixelRatio: HATCH_SCALE });
  }
}

/**
 * The hatch as a CSS background value, for the HTML legend swatch.
 *
 * `repeating-linear-gradient` measures its angle from "up", clockwise, while
 * HATCH.angle is from horizontal — hence the conversion. Its stops are measured
 * along the gradient axis, i.e. PERPENDICULAR to the stripes, so the period is
 * `HATCH_PERIOD` and not `HATCH.size`; using the latter would draw the legend's
 * stripes noticeably wider apart than the map's. Hard stops (a stop pair at the
 * same position) keep the edges crisp instead of blurring between colours.
 */
export function hatchCSS(colors: HatchColors): string {
  const cssAngle = 90 - HATCH.angle;
  return (
    `repeating-linear-gradient(${cssAngle}deg, ` +
    `${colors.color} 0 ${HATCH.stripe}px, ` +
    `${colors.background} ${HATCH.stripe}px ${HATCH_PERIOD}px)`
  );
}
