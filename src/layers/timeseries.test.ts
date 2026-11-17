import { describe, expect, it } from "vitest";

import { filterRasterForStep, initialStep } from "@/layers/timeseries";
import type { LayerConfig, TimeseriesConfig } from "@/layers/types";

const TIMESERIES: TimeseriesConfig = {
  placeholder: "%YEAR%",
  start: 2025,
  end: 2045,
  step: 5,
  intervalMs: 1000,
};

function layer(overrides: Partial<LayerConfig>): LayerConfig {
  return {
    id: "aandeel_j0_17",
    name: "Aandeel 0-17 jaar",
    source: "https://example.test/x.pmtiles",
    format: "pmtiles",
    style: {},
    ...overrides,
  };
}

/**
 * `filterRaster` is the one templated field resolved at the point of use rather
 * than rewritten into the config, so these cover the substitution the combine
 * flow depends on to fetch the raster for the year the legend is showing.
 */
describe("filterRasterForStep", () => {
  it("returns undefined when the layer has no companion raster", () => {
    expect(filterRasterForStep(layer({ timeseries: TIMESERIES }), 2030)).toBeUndefined();
  });

  it("passes a non-timeseries layer's raster through untouched", () => {
    const config = layer({ filterRaster: "https://example.test/huisarts_lb_m5.cog.tif" });
    expect(filterRasterForStep(config, 2030)).toBe(
      "https://example.test/huisarts_lb_m5.cog.tif",
    );
  });

  it("substitutes the requested step", () => {
    const config = layer({
      timeseries: TIMESERIES,
      filterRaster: "https://example.test/aandeel_j0_17_m5_%YEAR%.cog.tif",
    });
    expect(filterRasterForStep(config, 2040)).toBe(
      "https://example.test/aandeel_j0_17_m5_2040.cog.tif",
    );
  });

  it("falls back to the configured start when the layer was never stepped", () => {
    const config = layer({
      timeseries: TIMESERIES,
      filterRaster: "https://example.test/aandeel_j0_17_m5_%YEAR%.cog.tif",
    });
    expect(filterRasterForStep(config, undefined)).toBe(
      "https://example.test/aandeel_j0_17_m5_2025.cog.tif",
    );
  });

  it("falls back to the configured initial step when there is one", () => {
    const config = layer({
      timeseries: { ...TIMESERIES, initial: 2045 },
      filterRaster: "https://example.test/aandeel_j0_17_m5_%YEAR%.cog.tif",
    });
    expect(filterRasterForStep(config, undefined)).toBe(
      "https://example.test/aandeel_j0_17_m5_2045.cog.tif",
    );
  });

  it("replaces every occurrence of the placeholder", () => {
    const config = layer({
      timeseries: TIMESERIES,
      filterRaster: "https://example.test/%YEAR%/aandeel_%YEAR%.cog.tif",
    });
    expect(filterRasterForStep(config, 2035)).toBe(
      "https://example.test/2035/aandeel_2035.cog.tif",
    );
  });

  it("honours a non-default placeholder token", () => {
    const config = layer({
      timeseries: { ...TIMESERIES, placeholder: "{jaar}" },
      filterRaster: "https://example.test/aandeel_{jaar}.cog.tif",
    });
    expect(filterRasterForStep(config, 2030)).toBe(
      "https://example.test/aandeel_2030.cog.tif",
    );
  });
});

/**
 * Where a timeseries layer opens. A series that starts in the past (the
 * Leefbaarometer runs 2015-2024) should open on its latest year, so `initial`
 * overrides `start` — and every "not stepped yet" fallback reads it from here.
 */
describe("initialStep", () => {
  it("is the start when no initial step is configured", () => {
    expect(initialStep(TIMESERIES)).toBe(2025);
  });

  it("is the initial step when one is configured", () => {
    expect(initialStep({ ...TIMESERIES, initial: 2040 })).toBe(2040);
  });
});
