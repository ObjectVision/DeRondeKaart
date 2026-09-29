import { beforeEach, describe, expect, it, vi } from "vitest";

// A 2x2 COG whose single band is `BAND`, served for any URL. Counted, so a test
// can tell whether computeScoreGrid fetched at all.
const fromUrl = vi.hoisted(() => vi.fn());
vi.mock("geotiff", () => ({ fromUrl }));

import { NODATA, computeScoreGrid, type ScoreGrid } from "@/layers/filter-raster";

const BBOX: [number, number, number, number] = [0, 0, 20, 20];
const BAND = [1, 2, 3, NODATA];

function fakeTiff(band: number[], bbox = BBOX) {
  const image = {
    getWidth: () => 2,
    getHeight: () => 2,
    getBoundingBox: () => bbox,
    readRasters: async () => [band],
  };
  return { getImageCount: async () => 1, getImage: async () => image };
}

/** A score grid on the same 2x2 grid, as a combination would register it. */
function grid(data: number[], overrides: Partial<ScoreGrid> = {}): ScoreGrid {
  return { width: 2, height: 2, data: new Uint8Array(data), bbox: BBOX, filterCount: 2, ...overrides };
}

beforeEach(() => {
  fromUrl.mockReset();
  fromUrl.mockImplementation(async () => fakeTiff(BAND));
});

describe("computeScoreGrid with a combination as input", () => {
  it("scores a grid input exactly like the same values read from a raster", async () => {
    const filter = ["==", "band0", 2] as const;
    const fromRaster = await computeScoreGrid([{ url: "https://x.test/a.tif", filter: [...filter] }]);
    const fromGrid = await computeScoreGrid([{ grid: grid(BAND), filter: [...filter] }]);
    expect([...fromGrid.data]).toEqual([...fromRaster.data]);
  });

  it("counts a grid input as one criterion beside a raster", async () => {
    // Raster matches cells where band0 >= 2; the combination where it scored 2.
    const result = await computeScoreGrid([
      { url: "https://x.test/a.tif", filter: [">=", "band0", 2] },
      { grid: grid([2, 2, 1, NODATA]), filter: ["==", "band0", 2] },
    ]);
    expect([...result.data]).toEqual([1, 2, 1, NODATA]);
    expect(result.filterCount).toBe(2);
  });

  it("needs no fetch when every input is a combination", async () => {
    const result = await computeScoreGrid([
      { grid: grid([1, 2, 2, NODATA]), filter: ["==", "band0", 2] },
    ]);
    expect(fromUrl).not.toHaveBeenCalled();
    expect([...result.data]).toEqual([NODATA, 1, 1, NODATA]);
    expect(result.bbox).toEqual(BBOX);
  });

  it("rejects a grid of another size rather than scoring misaligned cells", async () => {
    await expect(
      computeScoreGrid([
        { url: "https://x.test/a.tif", filter: ["==", "band0", 1] },
        { grid: grid([1, 1, 1], { width: 3, height: 1 }), filter: ["==", "band0", 1] },
      ]),
    ).rejects.toThrow(/3x1, expected 2x2/);
  });

  it("rejects a grid over another extent", async () => {
    await expect(
      computeScoreGrid([
        { url: "https://x.test/a.tif", filter: ["==", "band0", 1] },
        { grid: grid(BAND, { bbox: [0, 0, 40, 40] }), filter: ["==", "band0", 1] },
      ]),
    ).rejects.toThrow(/covers/);
  });
});
