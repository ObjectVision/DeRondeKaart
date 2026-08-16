import { addProtocol } from "maplibre-gl";

import { NODATA, type ScoreGrid } from "@/layers/filter-raster";

/**
 * URL scheme for in-memory score grids, registered alongside the `cog` and
 * `pmtiles` protocols in MapView.
 *
 * A combined layer's data is computed in the browser and never exists as a file,
 * so it cannot be fetched. Serving it through a protocol is what lets it be an
 * ordinary MapLibre raster source — and therefore an ordinary `format: "cog"`
 * layer, reusing `addCogLayer`, restacking, opacity, hide/show and the legend
 * with no changes. Encoding the grid as a real COG client-side would need a COG
 * *writer*, which `geotiff` does not provide.
 */
export const SCORE_PROTOCOL = "cogmem";

/** Web Mercator world extent, the bounds of the WebMercatorQuad grid. */
const WORLD = 20037508.342789244;

/** Tile size the score sources are added with; matches the COG layers. */
const TILE_SIZE = 256;

/** Grids by id, keyed on the `cogmem://<id>` host segment. */
const grids = new globalThis.Map<string, RenderableGrid>();

interface RenderableGrid {
  grid: ScoreGrid;
  /** RGBA per score, indexed by score value (1..filterCount). */
  colors: Uint8ClampedArray[];
}

/** Parse "#rrggbb" into an RGBA quad at `alpha`. */
function hexToRgba(hex: string, alpha: number): Uint8ClampedArray {
  const h = hex.replace("#", "");
  return new Uint8ClampedArray([
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
    alpha,
  ]);
}

/**
 * Publish a score grid under `cogmem://<id>`, replacing any previous grid with
 * that id. Call before adding the source, so the first tile request finds it.
 */
export function registerScoreGrid(id: string, grid: ScoreGrid, colors: string[]): void {
  const table: Uint8ClampedArray[] = [];
  for (let score = 0; score <= grid.filterCount; score++) {
    // Last resort only: `colors` comes from rampFor and always has one entry
    // per attainable score, so neither fallback should be reachable. The literal
    // exists so a bad caller draws something visible rather than crashing.
    const hex = colors[score - 1] ?? colors[colors.length - 1] ?? "#3288bd";
    table[score] = hexToRgba(hex, 255);
  }
  grids.set(id, { grid, colors: table });
}

/** Drop a grid once its layer is removed, so the data can be collected. */
export function unregisterScoreGrid(id: string): void {
  grids.delete(id);
}

/** The `cogmem://<id>` URL for a registered grid, as a layer's `source`. */
export function scoreSourceUrl(id: string): string {
  return `${SCORE_PROTOCOL}://${id}`;
}

/** Web Mercator X/Y of a WebMercatorQuad tile's top-left corner. */
function tileOrigin(z: number, x: number, y: number): [number, number] {
  const span = (2 * WORLD) / 2 ** z;
  return [-WORLD + x * span, WORLD - y * span];
}

/**
 * Draw one 256x256 tile of a score grid.
 *
 * Nearest-neighbour by construction: each screen pixel maps to whichever cell
 * contains it, so score values are never blended — averaging two scores would
 * invent a third that no cell holds. Cells outside the grid, and cells that
 * passed no filter, stay fully transparent.
 */
function renderTile(entry: RenderableGrid, z: number, x: number, y: number): ImageData {
  const { grid, colors } = entry;
  const [minX, minY, maxX, maxY] = grid.bbox;
  const image = new ImageData(TILE_SIZE, TILE_SIZE);
  const span = (2 * WORLD) / 2 ** z;
  const [originX, originY] = tileOrigin(z, x, y);
  const step = span / TILE_SIZE;

  const cellW = (maxX - minX) / grid.width;
  const cellH = (maxY - minY) / grid.height;

  for (let py = 0; py < TILE_SIZE; py++) {
    // Pixel centre, so a pixel takes the cell it actually sits in.
    const worldY = originY - (py + 0.5) * step;
    if (worldY > maxY || worldY < minY) continue;
    const row = Math.floor((maxY - worldY) / cellH);
    if (row < 0 || row >= grid.height) continue;

    for (let px = 0; px < TILE_SIZE; px++) {
      const worldX = originX + (px + 0.5) * step;
      if (worldX < minX || worldX > maxX) continue;
      const col = Math.floor((worldX - minX) / cellW);
      if (col < 0 || col >= grid.width) continue;

      const score = grid.data[row * grid.width + col];
      if (score === NODATA || score === 0) continue;

      const color = colors[score];
      if (!color) continue;

      const offset = (py * TILE_SIZE + px) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    }
  }
  return image;
}

/** Encode an ImageData as PNG bytes, which is what a raster source consumes. */
async function toPngBytes(image: ImageData): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("score-protocol: no 2D context for tile rendering");
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}

/** Web Mercator metres -> WGS84 degrees, for the TileJSON bounds. */
function mercatorToLngLat(mx: number, my: number): [number, number] {
  const lng = (mx / WORLD) * 180;
  const lat =
    (Math.atan(Math.exp(((my / WORLD) * 180 * Math.PI) / 180)) * 360) / Math.PI - 90;
  return [lng, lat];
}

let registered = false;

/**
 * Register the protocol once per page. Idempotent, so importing this module
 * from more than one place is safe.
 *
 * Two request shapes arrive here, distinguished the same way `cogProtocol` does
 * it: a trailing `/z/x/y` is a tile, anything else is the source's TileJSON.
 */
export function registerScoreProtocol(): void {
  if (registered) return;
  registered = true;

  addProtocol(SCORE_PROTOCOL, async (params) => {
    const tileMatch = params.url.match(/^cogmem:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/);

    if (!tileMatch) {
      // TileJSON: describe where the grid is, so MapLibre only requests tiles
      // that intersect it rather than the whole world.
      const id = params.url.replace(`${SCORE_PROTOCOL}://`, "");
      const entry = grids.get(id);
      if (!entry) throw new Error(`score-protocol: unknown grid "${id}"`);
      const [minX, minY, maxX, maxY] = entry.grid.bbox;
      const [west, south] = mercatorToLngLat(minX, minY);
      const [east, north] = mercatorToLngLat(maxX, maxY);
      return {
        data: {
          tilejson: "2.2.0",
          tiles: [`${SCORE_PROTOCOL}://${id}/{z}/{x}/{y}`],
          minzoom: 0,
          maxzoom: 18,
          bounds: [west, south, east, north],
        },
      };
    }

    const [, id, z, x, y] = tileMatch;
    const entry = grids.get(id);
    if (!entry) throw new Error(`score-protocol: unknown grid "${id}"`);

    const image = renderTile(entry, Number(z), Number(x), Number(y));
    return { data: await toPngBytes(image) };
  });
}
