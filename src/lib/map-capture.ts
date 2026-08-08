import type { Map as MapLibreMap } from "maplibre-gl";
import type { ExportLegendItem, SwatchSpec } from "@/lib/legend-style";
import { HATCH, renderHatchTile, type HatchColors } from "@/layers/hatch-pattern";

/**
 * WebGL map capture + circular-PNG compositing utilities for the "Delen"
 * dialog and the Power BI snapshot bridge.
 *
 * MapLibre's canvas is a WebGL context created WITHOUT `preserveDrawingBuffer`,
 * so its pixels are only readable synchronously inside a `render` event —
 * after the browser composites, the buffer is cleared. Every capture here
 * triggers a repaint and copies the canvas onto a 2D canvas inside that
 * callback (never after an `await`).
 */

/** App UI font, matching --font-sans in index.css. */
const EXPORT_FONT = "'Geist Variable', sans-serif";

/**
 * Capture the map's current frame (basemap + interleaved deck.gl layers share
 * one canvas) onto a fresh 2D canvas of the same pixel size.
 */
export function captureMapCanvas(map: MapLibreMap): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    map.once("render", () => {
      try {
        const src = map.getCanvas();
        const copy = document.createElement("canvas");
        copy.width = src.width;
        copy.height = src.height;
        const ctx = copy.getContext("2d");
        if (!ctx) throw new Error("2D context unavailable");
        // Synchronous read inside the render callback — see module comment.
        ctx.drawImage(src, 0, 0);
        resolve(copy);
      } catch (err) {
        reject(err);
      }
    });
    map.triggerRepaint();
  });
}

/**
 * Temporarily boost every raster source's tile resolution for a hi-res
 * capture. MapLibre selects raster tiles by zoom + source `tileSize` only —
 * the canvas pixel ratio never enters tile selection — so a pixel-ratio
 * capture stretches the on-screen tiles (blurry luchtfoto/COG imagery) while
 * vectors re-render crisply. Lowering the declared tileSize by the capture
 * ratio (256 → 64 for a ~4-5× capture) makes MapLibre fetch tiles ~2 zoom
 * levels deeper for the same viewport: real source detail matching the output
 * resolution. Sources past their maxzoom overzoom parent tiles — no worse
 * than before.
 *
 * The swap is surgical (removeSource/addSource + re-adding dependent layers
 * in place) — a full setStyle would nuke the imperatively added MVT/COG and
 * deck custom layers. Returns a restore function; both directions are
 * defensive (warn + continue) so a capture can never break on a style quirk.
 */
function boostRasterSources(map: MapLibreMap, ratio: number): () => void {
  interface Swap {
    id: string;
    original: Record<string, unknown>;
    /** Dependent layers with the id of the layer that followed each (order). */
    layers: Array<{ spec: Record<string, unknown>; beforeId?: string }>;
  }
  const swaps: Swap[] = [];

  try {
    const factor = Math.pow(2, Math.round(Math.log2(Math.max(1, ratio))));
    const style = map.getStyle();
    if (!style?.sources) return () => {};

    for (const [id, source] of Object.entries(style.sources)) {
      if ((source as { type?: string }).type !== "raster") continue;
      const spec = source as unknown as Record<string, unknown> & { tileSize?: number };
      const currentTileSize = spec.tileSize ?? 512;
      const target = Math.max(32, Math.min(256, currentTileSize / factor));
      if (target >= currentTileSize) continue;

      // Dependent layers, each with its successor for order-true re-insertion.
      // The successor must be a layer of ANOTHER source: a same-source
      // successor is removed too and wouldn't exist yet at re-add time.
      const allLayers = style.layers ?? [];
      const layers: Swap["layers"] = [];
      for (let i = 0; i < allLayers.length; i++) {
        const l = allLayers[i] as unknown as Record<string, unknown> & { source?: string };
        if (l.source !== id) continue;
        let beforeId: string | undefined;
        for (let j = i + 1; j < allLayers.length; j++) {
          const next = allLayers[j] as unknown as { id?: string; source?: string };
          if (next.source !== id) {
            beforeId = next.id;
            break;
          }
        }
        layers.push({ spec: l, beforeId });
      }

      for (const l of layers) map.removeLayer(l.spec.id as string);
      map.removeSource(id);
      map.addSource(id, { ...spec, tileSize: target } as never);
      for (const l of layers) {
        map.addLayer(l.spec as never, l.beforeId && map.getLayer(l.beforeId) ? l.beforeId : undefined);
      }
      swaps.push({ id, original: spec, layers });
    }
  } catch (err) {
    console.warn("Raster tile-size boost failed; capturing at screen quality:", err);
  }

  return () => {
    for (const swap of swaps) {
      try {
        for (const l of swap.layers) {
          if (map.getLayer(l.spec.id as string)) map.removeLayer(l.spec.id as string);
        }
        map.removeSource(swap.id);
        map.addSource(swap.id, swap.original as never);
        for (const l of swap.layers) {
          map.addLayer(l.spec as never, l.beforeId && map.getLayer(l.beforeId) ? l.beforeId : undefined);
        }
      } catch (err) {
        console.warn(`Failed to restore raster source "${swap.id}":`, err);
      }
    }
  };
}

/**
 * Capture the map at a target pixel resolution without changing its framing:
 * temporarily raise the canvas pixel ratio so the same CSS-pixel viewport
 * renders at `targetPx` device pixels. Unlike a container-resize + zoom
 * bump, the pixel ratio scales label/symbol rendering too, so text in the
 * export keeps the same proportions the user sees in the preview.
 *
 * Requires `preserveDrawingBuffer: true` (the export preview map sets it):
 * the canvas is read synchronously inside the `idle` handler — the moment
 * every tile has finished drawing.
 */
export async function captureMapAtResolution(
  map: MapLibreMap,
  targetPx: number,
): Promise<HTMLCanvasElement> {
  const container = map.getContainer();
  const cssSize = Math.max(1, container.clientWidth);
  const ratio = targetPx / cssSize;

  // Fetch raster (luchtfoto/COG) tiles from deeper zoom levels so their
  // detail matches the capture resolution — pixel ratio alone only stretches
  // the current tiles. Restored in the finally below.
  const restoreRasters = boostRasterSources(map, ratio);
  map.setPixelRatio(ratio);
  try {
    return await new Promise<HTMLCanvasElement>((resolve, reject) => {
      map.once("idle", () => {
        try {
          const src = map.getCanvas();
          const copy = document.createElement("canvas");
          copy.width = src.width;
          copy.height = src.height;
          const ctx = copy.getContext("2d");
          if (!ctx) throw new Error("2D context unavailable");
          // Synchronous read inside the idle handler (see module comment).
          ctx.drawImage(src, 0, 0);
          resolve(copy);
        } catch (err) {
          reject(err);
        }
      });
      // Kick a repaint in case the map went idle before we subscribed.
      map.triggerRepaint();
    });
  } finally {
    map.setPixelRatio(window.devicePixelRatio);
    restoreRasters();
  }
}

/** One annotation callout: title drawn below the circle, leader line to (x,y). */
export interface CalloutLabel {
  title: string;
  /** Annotation color — fills the anchor dot on the shape. */
  color: string;
  /** Anchor in output-canvas pixels (the shape's center inside the circle). */
  x: number;
  y: number;
}

export interface CircularExportOptions {
  /** Square canvas holding the captured map (any resolution ≥ size). */
  mapCanvas: HTMLCanvasElement;
  /** Output width/height in pixels (e.g. 2048). */
  size: number;
  title: string;
  subtitle?: string;
  legend: ExportLegendItem[];
  /**
   * Annotation titles rendered as callout labels fanned along the circle's
   * bottom-right outer curve, each wired to its shape by a right-angle leader
   * line (classic annotated-map style). When labels wrap past the circle's
   * bottom point, the output canvas grows downward to hold them.
   */
  callouts?: CalloutLabel[];
}

/**
 * Compose the final circular export: the map clipped to an inscribed circle
 * on a transparent background, a rounded title card top-left and a legend
 * card bottom-left (the circle's corner whitespace, mirroring the dialog
 * preview). With `callouts`, the canvas grows downward by a band holding the
 * annotation titles, each wired to its shape by a leader line. Only plain
 * text and shapes are drawn — no icon-font glyphs, which would rasterize as
 * tofu. Waits for document fonts so Geist (not a fallback) is measured and
 * drawn.
 */
/**
 * Preload the icon images referenced by legend rows, keyed by URL. A failed
 * load is simply omitted — the drawing falls back to a color square rather
 * than rejecting the whole export.
 */
async function preloadSwatchIcons(
  legend: ExportLegendItem[],
): Promise<Map<string, HTMLImageElement>> {
  const urls = [
    ...new Set(
      legend.flatMap((item) => (item.spec?.kind === "icon" ? [item.spec.url] : [])),
    ),
  ];
  const icons = new Map<string, HTMLImageElement>();
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            icons.set(url, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        }),
    ),
  );
  return icons;
}

/**
 * The hatch tile as a canvas pattern, at the same logical scale the CSS swatch
 * uses (HATCH.size px per repeat) so the exported PNG matches the on-screen
 * legend. `renderHatchTile` returns ImageData, which createPattern won't take —
 * so it goes onto an intermediate canvas, downscaled from its supersampled size.
 */
function hatchCanvasPattern(
  ctx: CanvasRenderingContext2D,
  colors: HatchColors,
): CanvasPattern | null {
  const data = renderHatchTile(colors);
  const src = document.createElement("canvas");
  src.width = data.width;
  src.height = data.height;
  src.getContext("2d")?.putImageData(data, 0, 0);

  const tile = document.createElement("canvas");
  tile.width = HATCH.size;
  tile.height = HATCH.size;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  tctx.drawImage(src, 0, 0, HATCH.size, HATCH.size);

  return ctx.createPattern(tile, "repeat");
}

/**
 * Draw one kind-aware legend swatch (the canvas twin of the <Swatch/> React
 * component) centered vertically on `cy`, in a `box`-sized square at `x`.
 */
function drawSwatch(
  ctx: CanvasRenderingContext2D,
  spec: SwatchSpec,
  x: number,
  cy: number,
  box: number,
  icons: Map<string, HTMLImageElement>,
): void {
  // The React swatch is spec'd against a 10px box; scale its px values.
  const k = box / 10;
  const neutral = "#d1d5db"; // gray-300, same hairline as the HTML swatches

  switch (spec.kind) {
    case "line": {
      const barH = Math.min(Math.max(spec.width, 1), 4) * k;
      ctx.fillStyle = spec.color;
      ctx.fillRect(x, cy - barH / 2, box, barH);
      return;
    }
    case "circle": {
      // Map-radius-derived with the same 18px cap as the HTML <Swatch/>, so
      // classes differing only by radius stay distinguishable in the PNG too.
      const r = (Math.min(Math.max(2 * spec.radius, 5), 18) * k) / 2;
      ctx.beginPath();
      ctx.arc(x + box / 2, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = spec.color;
      ctx.fill();
      ctx.strokeStyle = spec.strokeColor ?? neutral;
      ctx.lineWidth = Math.min(spec.strokeWidth ?? 1, 2) * k;
      ctx.stroke();
      return;
    }
    case "icon": {
      const img = icons.get(spec.url);
      if (img) {
        if (spec.tint) {
          // SDF-style tinting: draw the shape, then recolor its opaque pixels.
          const tile = document.createElement("canvas");
          tile.width = box;
          tile.height = box;
          const tctx = tile.getContext("2d");
          if (tctx) {
            tctx.drawImage(img, 0, 0, box, box);
            tctx.globalCompositeOperation = "source-in";
            tctx.fillStyle = spec.tint;
            tctx.fillRect(0, 0, box, box);
            ctx.drawImage(tile, x, cy - box / 2);
            return;
          }
        }
        ctx.drawImage(img, x, cy - box / 2, box, box);
        return;
      }
      // Image failed to load — fall through to a tinted square.
      ctx.fillStyle = spec.tint ?? "#0080ff";
      ctx.fillRect(x, cy - box / 2, box, box);
      return;
    }
    case "fill":
    default: {
      // Hatched classes get the same tile the map's sprite uses, scaled down to
      // the swatch box so the stripe spacing matches the HTML <Swatch/>.
      const pattern = spec.hatch ? hatchCanvasPattern(ctx, spec.hatch) : null;
      ctx.fillStyle = pattern ?? spec.color;
      ctx.fillRect(x, cy - box / 2, box, box);
      ctx.strokeStyle = spec.outline ?? neutral;
      ctx.lineWidth = k;
      ctx.strokeRect(x, cy - box / 2, box, box);
      return;
    }
  }
}

export async function composeCircularExport(
  options: CircularExportOptions,
): Promise<HTMLCanvasElement> {
  const { mapCanvas, size, title, subtitle, legend, callouts } = options;
  await document.fonts.ready;
  const swatchIcons = await preloadSwatchIcons(legend);

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  // Layout constants scale with the output size (spec'd against 2048).
  const u = size / 2048;
  const pad = 40 * u; // card padding
  const margin = 32 * u; // distance from canvas edge
  const radius = 24 * u; // card corner radius

  // Callout band layout — must run BEFORE drawing: the canvas grows downward
  // to hold the labels, and resizing a canvas clears it.
  const placedCallouts = layoutCallouts(ctx, callouts ?? [], size, u);
  if (placedCallouts.bandH > 0) {
    out.height = size + placedCallouts.bandH; // resets ctx state; nothing drawn yet
  }

  // Map, clipped to the inscribed circle.
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(mapCanvas, 0, 0, size, size);
  ctx.restore();

  // Leader lines + labels — over the map but under the title/legend cards.
  drawCallouts(ctx, placedCallouts, u);

  const drawCard = (x: number, y: number, w: number, h: number) => {
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.15)";
    ctx.shadowBlur = 16 * u;
    ctx.shadowOffsetY = 4 * u;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    ctx.restore();
  };

  // Title card — top-left corner whitespace.
  const titleText = title.trim();
  const subtitleText = subtitle?.trim() ?? "";
  if (titleText || subtitleText) {
    const titleFont = `600 ${56 * u}px ${EXPORT_FONT}`;
    const subtitleFont = `italic 400 ${40 * u}px ${EXPORT_FONT}`;
    ctx.font = titleFont;
    const titleWidth = titleText ? ctx.measureText(titleText).width : 0;
    ctx.font = subtitleFont;
    const subtitleWidth = subtitleText ? ctx.measureText(subtitleText).width : 0;

    const cardW = Math.min(size * 0.6, Math.max(titleWidth, subtitleWidth) + pad * 2);
    const lineGap = 16 * u;
    const cardH =
      pad * 2 +
      (titleText ? 56 * u : 0) +
      (titleText && subtitleText ? lineGap : 0) +
      (subtitleText ? 40 * u : 0);
    drawCard(margin, margin, cardW, cardH);

    ctx.textBaseline = "top";
    let textY = margin + pad;
    if (titleText) {
      ctx.font = titleFont;
      ctx.fillStyle = "#111827"; // gray-900
      ctx.fillText(titleText, margin + pad, textY, cardW - pad * 2);
      textY += 56 * u + lineGap;
    }
    if (subtitleText) {
      ctx.font = subtitleFont;
      ctx.fillStyle = "#6b7280"; // gray-500
      ctx.fillText(subtitleText, margin + pad, textY, cardW - pad * 2);
    }
  }

  // Legend card — anchored to the canvas's bottom-left corner, so its left
  // edge lines up with the circle's leftmost point and its bottom edge with
  // the circle's bottom point (the card floats over the corner whitespace).
  if (legend.length > 0) {
    const fontSize = 36 * u;
    const rowFont = `400 ${fontSize}px ${EXPORT_FONT}`;
    const headingFont = `600 ${fontSize}px ${EXPORT_FONT}`;
    const legendPad = 40 * u;
    const swatch = 32 * u;
    const rowH = 52 * u;
    const swatchGap = 16 * u;

    let maxRowWidth = 0;
    for (const item of legend) {
      ctx.font = item.heading ? headingFont : rowFont;
      const w =
        ctx.measureText(item.label).width + (item.heading ? 0 : swatch + swatchGap);
      maxRowWidth = Math.max(maxRowWidth, w);
    }
    const cardW = Math.min(size * 0.45, maxRowWidth + legendPad * 2);
    const cardH = legend.length * rowH + legendPad * 2 - (rowH - fontSize);
    const cardX = 0;
    const cardY = size - cardH;
    drawCard(cardX, cardY, cardW, cardH);

    ctx.textBaseline = "middle";
    let rowY = cardY + legendPad + fontSize / 2;
    for (const item of legend) {
      let textX = cardX + legendPad;
      if (!item.heading) {
        drawSwatch(
          ctx,
          item.spec ?? { kind: "fill", color: "#0080ff" },
          cardX + legendPad,
          rowY,
          swatch,
          swatchIcons,
        );
        textX += swatch + swatchGap;
      }
      ctx.font = item.heading ? headingFont : rowFont;
      ctx.fillStyle = "#1f2937"; // gray-800
      ctx.fillText(item.label, textX, rowY, cardW - legendPad * 2 - (item.heading ? 0 : swatch + swatchGap));
      rowY += rowH;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Annotation callouts: titles in a band below the circle, leader lines up to
// their shapes (classic annotated-map style).
// ---------------------------------------------------------------------------

const CALLOUT_TEXT_H = 36; // px at 2048 (multiplied by u)
/** Minimum distance between callout text and the circle's outer radius (px at 2048). */
const CALLOUT_RIM_CLEARANCE = 48;

interface PlacedCallout {
  title: string;
  color: string;
  anchorX: number;
  anchorY: number;
  /** Text top-left in output pixels. */
  labelX: number;
  labelY: number;
  width: number;
  /** X of the vertical leader segment (above the label's curve-side end). */
  leaderX: number;
}

interface CalloutLayout {
  placed: PlacedCallout[];
  /** Extra canvas height below the circle square (0 = no band). */
  bandH: number;
}

/** Shorten a title with an ellipsis until it fits maxW (ctx.font pre-set). */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) {
    t = t.slice(0, -1).trimEnd();
  }
  return `${t}…`;
}

/**
 * Fan the labels along the circle's bottom-right outer curve (classic
 * annotated-map style): one label per slot, top slots just outside the rim in
 * the lower-right corner whitespace, further slots wrapping past the circle's
 * bottom point and sliding down-left along the curve's continuation. The
 * rightmost anchors take the upper-right slots so leader lines don't cross.
 */
function layoutCallouts(
  ctx: CanvasRenderingContext2D,
  callouts: CalloutLabel[],
  size: number,
  u: number,
): CalloutLayout {
  const items = callouts.filter((c) => c.title.trim().length > 0);
  if (items.length === 0) return { placed: [], bandH: 0 };

  ctx.font = `400 ${CALLOUT_TEXT_H * u}px ${EXPORT_FONT}`;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;
  const textH = CALLOUT_TEXT_H * u;
  const margin = 32 * u;
  // Minimum clearance between any label text and the circle's outer radius:
  // labels are laid out against this virtual expanded circle, measured at the
  // text edge closest to the rim.
  const rimClearance = CALLOUT_RIM_CLEARANCE * u;
  const R = r + rimClearance;
  const rowH = 96 * u; // vertical slot pitch
  const maxLabelW = size * 0.45;

  // Rightmost anchors first — they take the highest (most-right) slots.
  const sorted = [...items].sort((a, b) => b.x - a.x || a.y - b.y);

  // First slot sits where the rim has receded enough to leave label room in
  // the corner whitespace (~1.5 rows above the circle's bottom edge).
  const yFirst = size - 1.5 * rowH;

  const placed: PlacedCallout[] = sorted.map((c, i) => {
    const labelY = yFirst + i * rowH; // text top
    const yMid = labelY + textH / 2;
    let title: string;
    let width: number;
    let labelX: number;
    let leaderX: number;

    // The label's top edge is its closest point to the circle (slots sit
    // below the center) — clearance is enforced there against the expanded
    // radius R, so no corner of the text can come nearer than rimClearance.
    const dyTop = labelY - cy;
    const expandedHalfW = Math.sqrt(Math.max(0, R * R - dyTop * dyTop));

    if (yMid < size) {
      // Beside the rim: text starts on the expanded circle at this height
      // and extends right into the corner whitespace.
      const startX = cx + expandedHalfW;
      const maxW = Math.max(60 * u, size - margin - startX);
      title = ellipsize(ctx, c.title.trim(), Math.min(maxW, maxLabelW));
      width = ctx.measureText(title).width;
      labelX = startX;
      leaderX = labelX + 10 * u; // leader rises above the first characters
    } else {
      // Wrapped past the bottom point: right-align the text so its end hugs
      // the curve's continuation, sliding left as the slots descend — but
      // never closer to the circle than the expanded radius allows (the
      // bottom bulge still spans a wide x-range just above these slots).
      const t = yMid - size;
      const curveX = cx - t * 1.3 - rimClearance;
      const boundaryX = dyTop < R ? cx - expandedHalfW : Number.POSITIVE_INFINITY;
      const xRight = Math.min(curveX, boundaryX);
      const maxW = Math.max(60 * u, xRight - margin);
      title = ellipsize(ctx, c.title.trim(), Math.min(maxW, maxLabelW));
      width = ctx.measureText(title).width;
      labelX = xRight - width;
      leaderX = labelX + width - 10 * u; // leader above the last characters
    }

    return {
      title,
      color: c.color,
      anchorX: c.x,
      anchorY: c.y,
      labelX,
      labelY,
      width,
      leaderX,
    };
  });

  const lastY = placed[placed.length - 1].labelY;
  const bandH = Math.max(0, lastY + textH + 32 * u - size);
  return { placed, bandH };
}

/** Draw the leader lines, anchor dots and label texts of a callout layout. */
function drawCallouts(ctx: CanvasRenderingContext2D, layout: CalloutLayout, u: number): void {
  ctx.save();
  for (const c of layout.placed) {
    // Right-angle leader (screenshot style): vertical from just above the
    // label's curve-side end up to the anchor's height, then horizontal to
    // the anchor dot.
    ctx.strokeStyle = "#4b5563"; // gray-600
    ctx.lineWidth = 2.5 * u;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(c.leaderX, c.labelY - 8 * u);
    ctx.lineTo(c.leaderX, c.anchorY);
    ctx.lineTo(c.anchorX, c.anchorY);
    ctx.stroke();

    // Anchor dot in the annotation's color, white-ringed for contrast.
    ctx.beginPath();
    ctx.arc(c.anchorX, c.anchorY, 7 * u, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5 * u;
    ctx.stroke();

    ctx.font = `400 ${CALLOUT_TEXT_H * u}px ${EXPORT_FONT}`;
    ctx.fillStyle = "#1f2937"; // gray-800
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(c.title, c.labelX, c.labelY);
  }
  ctx.restore();
}

/** Trigger a browser download of the canvas as a PNG file. */
export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

/** Trigger a browser download of a data-URL image (e.g. the QR code). */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/**
 * Composite the comparison view for the Power BI snapshot: the left canvas up
 * to the slider, the right canvas after it. Both canvases are full-viewport
 * captures of the same size.
 */
export function compositeComparison(
  left: HTMLCanvasElement,
  right: HTMLCanvasElement,
  sliderPct: number,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = left.width;
  out.height = left.height;
  const ctx = out.getContext("2d");
  if (!ctx) return left;
  const split = Math.round((left.width * sliderPct) / 100);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, split, out.height);
  ctx.clip();
  ctx.drawImage(left, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(split, 0, out.width - split, out.height);
  ctx.clip();
  ctx.drawImage(right, 0, 0);
  ctx.restore();

  return out;
}
