import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";

const computeScoreGrid = vi.hoisted(() => vi.fn());

vi.mock("@/layers/filter-raster", () => ({
  computeScoreGrid,
}));
vi.mock("@/layers/score-protocol", () => ({
  registerScoreGrid: vi.fn(),
  unregisterScoreGrid: vi.fn(),
}));

import { useFilterLayers } from "@/hooks/use-filter-layers";
import { removeFilterLayer, getFilterLayers } from "@/layers/filter-layers";
import type { GeoStylerRule, LayerConfig } from "@/layers/types";

const RULES: GeoStylerRule[] = [
  { name: "0-10%", filter: ["==", "class", 1], symbolizers: [] },
];

function aandeelLayer(): LayerConfig {
  return {
    id: "aandeel_j0_17",
    name: "Aandeel 0-17 jaar",
    source: "https://example.test/prognose.pmtiles",
    format: "pmtiles",
    style: {},
    sourceLayer: "%YEAR%_aandeel_j0_17_m5",
    timeseries: { placeholder: "%YEAR%", start: 2025, end: 2045, step: 5, intervalMs: 1000 },
    filterRaster: "https://example.test/aandeel_j0_17_m5_%YEAR%.cog.tif",
    geostyler: { name: "Aandeel", rules: RULES },
  } as LayerConfig;
}

/** The URLs `create` resolved on its single computeScoreGrid call. */
function requestedUrls(): string[] {
  const inputs = computeScoreGrid.mock.calls[0][0] as { url: string }[];
  return inputs.map((input) => input.url);
}

beforeEach(() => {
  computeScoreGrid.mockReset();
  computeScoreGrid.mockResolvedValue({
    width: 1,
    height: 1,
    data: new Uint8Array([1]),
    bbox: [0, 0, 1, 1],
    filterCount: 1,
  });
  for (const def of getFilterLayers()) removeFilterLayer(def.id);
});

/**
 * The combine flow's contract for timeseries layers: the companion raster is
 * fetched for the step the legend was showing when the user clicked, not for
 * the layer's configured start.
 */
describe("useFilterLayers.create", () => {
  it("resolves a timeseries layer's raster to the current step", async () => {
    await createRoot(async (dispose) => {
      const filters = useFilterLayers(
        async () => undefined,
        () => undefined,
      );
      await filters.create(
        "test",
        [{ layerId: "aandeel_j0_17", ruleName: "0-10%" }],
        [aandeelLayer()],
        [],
        () => 2040,
      );
      expect(requestedUrls()).toEqual([
        "https://example.test/aandeel_j0_17_m5_2040.cog.tif",
      ]);
      dispose();
    });
  });

  it("falls back to the start step when the layer was never stepped", async () => {
    await createRoot(async (dispose) => {
      const filters = useFilterLayers(
        async () => undefined,
        () => undefined,
      );
      await filters.create(
        "test",
        [{ layerId: "aandeel_j0_17", ruleName: "0-10%" }],
        [aandeelLayer()],
        [],
        () => undefined,
      );
      expect(requestedUrls()).toEqual([
        "https://example.test/aandeel_j0_17_m5_2025.cog.tif",
      ]);
      dispose();
    });
  });

  it("leaves a non-timeseries layer's raster unsubstituted", async () => {
    const plain = {
      ...aandeelLayer(),
      id: "huisarts",
      timeseries: undefined,
      filterRaster: "https://example.test/huisarts_lb_m5.cog.tif",
    } as LayerConfig;
    await createRoot(async (dispose) => {
      const filters = useFilterLayers(
        async () => undefined,
        () => undefined,
      );
      await filters.create(
        "test",
        [{ layerId: "huisarts", ruleName: "0-10%" }],
        [plain],
        [],
        () => 2040,
      );
      expect(requestedUrls()).toEqual(["https://example.test/huisarts_lb_m5.cog.tif"]);
      dispose();
    });
  });
});
