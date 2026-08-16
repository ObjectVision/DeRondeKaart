import { fromUrl } from "geotiff";

import { evaluateFilter } from "@/layers/geostyler";
import type { GeoStylerFilter } from "@/layers/types";

/**
 * Nodata sentinel for both the source class rasters and the score grid. Matches
 * the convention in `data/convert-tif-to-cog-10m.py` and
 * `data/convert-tif-to-geojson.py`.
 */
export const NODATA = 255;

/** One filter to test against one raster, already resolved to its source. */
export interface ScoreInput {
  /** URL of the layer's companion class COG (`LayerConfig.filterRaster`). */
  url: string;
  /** The rule's own GeoStyler filter, reused verbatim from the vector layer. */
  filter: GeoStylerFilter;
}

/**
 * Property names a cell value is exposed under while evaluating a filter.
 *
 * A rule written for a vector layer names its own attribute — the pilot layers
 * use `class` (`["==", "class", 3]`) — while rules written against a COG use
 * `band0`. The same cell value is bound to every candidate name so a rule is
 * reusable verbatim from either kind of layer, which is the whole point of
 * combining "classes the layer already defines".
 *
 * This is safe because these filters only ever test the single class band: a
 * companion raster has exactly one band, so there is no second attribute a name
 * could ambiguously refer to.
 */
const VALUE_ALIASES = ["band0", "class", "value", "DN"];

/** Extract the attribute names a filter compares against. */
function filterProperties(filter: GeoStylerFilter, out: Set<string>): void {
  const op = filter[0];
  if (op === "&&" || op === "||") {
    for (const sub of (filter as unknown[]).slice(1)) {
      filterProperties(sub as GeoStylerFilter, out);
    }
    return;
  }
  if (op === "!") {
    filterProperties(filter[1] as GeoStylerFilter, out);
    return;
  }
  if (typeof filter[1] === "string") out.add(filter[1]);
}

/** A scored grid: per-cell count of how many filters passed. */
export interface ScoreGrid {
  width: number;
  height: number;
  /** Cell value 1..N = filters passed; {@link NODATA} = no filter passed. */
  data: Uint8Array;
  /** Bounding box in the rasters' CRS (EPSG:3857), as [minX, minY, maxX, maxY]. */
  bbox: [number, number, number, number];
  /** How many filters went into the score — the top of the class range. */
  filterCount: number;
}

/**
 * Read each input raster at the same overview level and count, per cell, how
 * many of the filters pass.
 *
 * The whole method rests on the inputs sharing one grid, which
 * `convert-tif-to-cog-10m.py --expect-grid` asserts at build time: identical
 * CRS, transform and size means cell *i* of every raster covers the same ground,
 * so combining is plain array arithmetic with no resampling or spatial join.
 * That is checked again here rather than trusted, because a mismatch produces a
 * plausible-looking but wrong overlay.
 *
 * A cell that passes nothing becomes {@link NODATA} rather than 0, so it renders
 * transparent: "no filter matched here" and "zero of three matched here" are the
 * same statement, and drawing it would hide the basemap for no reason.
 *
 * `overviewLevel` trades resolution for bytes — the COGs carry 5 levels, and the
 * coarser ones are enough for a screen-sized overlay while downloading far less.
 */
export async function computeScoreGrid(
  inputs: ScoreInput[],
  overviewLevel = 2,
): Promise<ScoreGrid> {
  if (inputs.length === 0) {
    throw new Error("computeScoreGrid: no filters given");
  }

  // Distinct URLs only: several classes of the SAME layer are common (the user
  // ticks two adjacent distance bands), and re-fetching one raster per class
  // would multiply the download for identical bytes.
  const urls = [...new Set(inputs.map((input) => input.url))];
  const opened = await Promise.all(
    urls.map(async (url) => {
      const tiff = await fromUrl(url);
      const count = await tiff.getImageCount();
      // Clamp: a raster with fewer overviews than requested still has to line up
      // with its peers, so everything falls back to the coarsest shared level.
      const image = await tiff.getImage(Math.min(overviewLevel, count - 1));
      // Only the full-resolution image carries the affine transform — asking an
      // overview for its bounding box throws. The overview covers the same
      // ground, so the extent comes from image 0 either way.
      const full = await tiff.getImage(0);
      return { image, bbox: full.getBoundingBox() as [number, number, number, number] };
    }),
  );

  const images = opened.map((entry) => entry.image);
  const width = images[0].getWidth();
  const height = images[0].getHeight();
  const bbox = opened[0].bbox;

  for (let i = 1; i < images.length; i++) {
    if (images[i].getWidth() !== width || images[i].getHeight() !== height) {
      throw new Error(
        `Filter rasters are not on the same grid: ${urls[i]} is ` +
          `${images[i].getWidth()}x${images[i].getHeight()}, expected ${width}x${height}. ` +
          "Re-run convert-tif-to-cog-10m.py with the same --zoom for every input.",
      );
    }
    // Equal size but a different extent would still misalign, cell for cell.
    if (opened[i].bbox.some((v, axis) => Math.abs(v - bbox[axis]) > 1e-6)) {
      throw new Error(
        `Filter rasters cover different extents: ${urls[i]} is ` +
          `[${opened[i].bbox.join(", ")}], expected [${bbox.join(", ")}].`,
      );
    }
  }

  const bands = await Promise.all(
    images.map(async (image) => {
      const rasters = await image.readRasters({ interleave: false });
      return rasters[0] as ArrayLike<number>;
    }),
  );

  // Band per input, resolved once so the per-cell loop does no lookups.
  const bandByInput = inputs.map((input) => bands[urls.indexOf(input.url)]);
  const filters = inputs.map((input) => input.filter);

  // Names each filter actually reads, so the cell value is bound under the
  // property that filter names (see VALUE_ALIASES).
  const namesByFilter = filters.map((filter) => {
    const names = new Set<string>(VALUE_ALIASES);
    filterProperties(filter, names);
    return [...names];
  });

  const data = new Uint8Array(width * height);
  // Reused across every cell — mutated in place to avoid per-cell allocation,
  // the same approach cog-style.ts takes for its per-pixel color function.
  const properties: Record<string, number> = {};

  for (let cell = 0; cell < data.length; cell++) {
    let score = 0;
    for (let f = 0; f < filters.length; f++) {
      const value = bandByInput[f][cell];
      if (value === NODATA) continue;
      for (const name of namesByFilter[f]) properties[name] = value;
      if (evaluateFilter(filters[f], properties)) score++;
    }
    data[cell] = score === 0 ? NODATA : score;
  }

  return { width, height, data, bbox, filterCount: inputs.length };
}

/** Count cells per score, for reporting and for verifying a combination. */
export function scoreHistogram(grid: ScoreGrid): Map<number, number> {
  const counts = new globalThis.Map<number, number>();
  for (const value of grid.data) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
