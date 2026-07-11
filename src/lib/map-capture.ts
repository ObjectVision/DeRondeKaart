import type { Map as MapLibreMap } from "maplibre-gl";
import type { ExportLegendItem } from "@/lib/legend-style";

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
 * Capture the map at a target pixel resolution without changing its framing:
 * temporarily raise the canvas pixel ratio so the same CSS-pixel viewport
 * renders at `targetPx` device pixels (tiles/labels reload at the higher
 * density), capture once the map is idle, then restore. The result is exactly
 * `targetPx` wide (and, for a square container, square).
 */
export async function captureMapAtResolution(
  map: MapLibreMap,
  targetPx: number,
): Promise<HTMLCanvasElement> {
  const container = map.getContainer();
  const cssSize = Math.max(1, container.clientWidth);
  const ratio = targetPx / cssSize;

  map.setPixelRatio(ratio);
  try {
    await new Promise<void>((resolve) => map.once("idle", () => resolve()));
    return await captureMapCanvas(map);
  } finally {
    map.setPixelRatio(window.devicePixelRatio);
  }
}

export interface CircularExportOptions {
  /** Square canvas holding the captured map (any resolution ≥ size). */
  mapCanvas: HTMLCanvasElement;
  /** Output width/height in pixels (e.g. 2048). */
  size: number;
  title: string;
  subtitle?: string;
  legend: ExportLegendItem[];
}

/**
 * Compose the final circular export: the map clipped to an inscribed circle
 * on a transparent background, a rounded title card top-left and a legend
 * card bottom-left (the circle's corner whitespace, mirroring the dialog
 * preview). Only plain text and shapes are drawn — no icon-font glyphs, which
 * would rasterize as tofu. Waits for document fonts so Geist (not a fallback)
 * is measured and drawn.
 */
export async function composeCircularExport(
  options: CircularExportOptions,
): Promise<HTMLCanvasElement> {
  const { mapCanvas, size, title, subtitle, legend } = options;
  await document.fonts.ready;

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");

  // Map, clipped to the inscribed circle.
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(mapCanvas, 0, 0, size, size);
  ctx.restore();

  // Layout constants scale with the output size (spec'd against 2048).
  const u = size / 2048;
  const pad = 40 * u; // card padding
  const margin = 32 * u; // distance from canvas edge
  const radius = 24 * u; // card corner radius

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

  // Legend card — bottom-left corner whitespace.
  if (legend.length > 0) {
    const rowFont = `400 ${36 * u}px ${EXPORT_FONT}`;
    const headingFont = `600 ${36 * u}px ${EXPORT_FONT}`;
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
    const cardW = Math.min(size * 0.45, maxRowWidth + pad * 2);
    const cardH = legend.length * rowH + pad * 2 - (rowH - 36 * u);
    const cardX = margin;
    const cardY = size - margin - cardH;
    drawCard(cardX, cardY, cardW, cardH);

    ctx.textBaseline = "middle";
    let rowY = cardY + pad + (36 * u) / 2;
    for (const item of legend) {
      let textX = cardX + pad;
      if (!item.heading) {
        ctx.fillStyle = item.color || "#0080ff";
        ctx.fillRect(cardX + pad, rowY - swatch / 2, swatch, swatch);
        ctx.strokeStyle = "#d1d5db"; // gray-300
        ctx.lineWidth = 2 * u;
        ctx.strokeRect(cardX + pad, rowY - swatch / 2, swatch, swatch);
        textX += swatch + swatchGap;
      }
      ctx.font = item.heading ? headingFont : rowFont;
      ctx.fillStyle = "#1f2937"; // gray-800
      ctx.fillText(item.label, textX, rowY, cardW - pad * 2 - (item.heading ? 0 : swatch + swatchGap));
      rowY += rowH;
    }
  }

  return out;
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
