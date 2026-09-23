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

/** A hatch's colours and stripe width, all fully resolved. */
export interface HatchColors {
  color: string;
  background: string;
  /**
   * Drawn line width in logical px. Defaults to {@link HATCH}.stripe — thin
   * lines over a broad ground, which is what "no value here" should look like.
   *
   * A rule that means two things at once rather than nothing wants equal bands
   * instead, which is `HATCH_PERIOD / 2` (≈2.83 at the default geometry). Per
   * symbolizer rather than global: widening the constant would restyle every
   * "Geen doorrekening" class in the app.
   */
  stripe: number;
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
const HATCH_PERIOD = HATCH.size / Math.SQRT2;

/**
 * Supersampling factor for the sprite tile: the image is drawn at this many
 * device px per logical px and registered with a matching `pixelRatio`, so the
 * diagonals stay smooth without changing the drawn size.
 */
const HATCH_SCALE = 2;

/** Red on white, matching the design this was introduced for. */
const HATCH_DEFAULTS: HatchColors = {
  color: "#E02B27",
  background: "#ffffff",
  stripe: HATCH.stripe,
};

/** Stripe width that splits the period evenly — two equal bands of colour. */
export const HATCH_EQUAL_BANDS = HATCH_PERIOD / 2;

/**
 * Resolve a symbolizer's `hatch` field (`true` or a partial override) to full
 * colours. `undefined` in, `undefined` out — callers use that to test opt-in.
 */
export function resolveHatch(
  hatch: boolean | { color?: string; background?: string; stripe?: number } | undefined,
): HatchColors | undefined {
  if (!hatch) return undefined;
  if (hatch === true) return HATCH_DEFAULTS;
  return {
    color: hatch.color ?? HATCH_DEFAULTS.color,
    background: hatch.background ?? HATCH_DEFAULTS.background,
    stripe: hatch.stripe ?? HATCH_DEFAULTS.stripe,
  };
}

/**
 * Sprite id for a hatch, keyed on its colours so every layer sharing a colour
 * pair shares one sprite entry (189 layers do). Same idea as `iconSpriteId`.
 *
 * The stripe width is part of the key: `addImage` is a no-op once the id is
 * taken, so two widths of one colour pair sharing an id would leave whichever
 * registered second silently drawing the first one's geometry.
 */
export function hatchPatternId(colors: HatchColors): string {
  return `hatch-${colors.color}-${colors.background}-${colors.stripe}`;
}

/**
 * The stripe centrelines to stroke for one tile, as [[x1,y1],[x2,y2]] pairs.
 *
 * A "/" line through (c, 0) is x + y = c. Stepping c by the diagonal spacing
 * (period * √2 in x/y terms) walks from one stripe to the next; the tile needs
 * c from 0 to 2*px, plus one on each side for the corner segments.
 *
 * Each segment OVERHANGS the tile by a full `px` at both ends, and that is
 * load-bearing rather than slack. The stroke uses a butt cap, which paints
 * nothing past an endpoint, so a segment stopping on the tile's own diagonal
 * extent leaves every pixel whose perpendicular foot falls beyond that end
 * unpainted — a triangle scaling with HALF THE STROKE WIDTH, at every tile.
 * At the 1px default that is sub-pixel and invisible; at an equal-band stripe
 * it is a visible bite out of each stripe. The overhang is far larger than any
 * half-width a stripe can sensibly have (one wider than the period stops being
 * a hatch), so the caps always land outside the tile.
 *
 * Split out of renderHatchTile so it can be tested: the tile itself needs a 2D
 * context, which jsdom has not got.
 */
export function hatchSegments(scale: number): [[number, number], [number, number]][] {
  const px = HATCH.size * scale;
  const cStep = HATCH_PERIOD * Math.SQRT2 * scale;
  const reach = 2 * px;

  const segments: [[number, number], [number, number]][] = [];
  for (let c = -cStep; c <= 2 * px + cStep; c += cStep) {
    segments.push([
      [c + reach, -reach],
      [c - reach, reach],
    ]);
  }
  return segments;
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
  ctx.lineWidth = colors.stripe * scale;
  ctx.lineCap = "butt";

  for (const [[ax, ay], [bx, by]] of hatchSegments(scale)) {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
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
    // `symbolizers` is optional: a rule may carry raw `type`/`paint` overrides
    // and no symbolizer at all (see buildRuleLayerDef), so index defensively —
    // reading [0] off a missing array threw here and aborted the whole layer.
    const sym = rule.symbolizers?.[0];
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
    `${colors.color} 0 ${colors.stripe}px, ` +
    `${colors.background} ${colors.stripe}px ${HATCH_PERIOD}px)`
  );
}
