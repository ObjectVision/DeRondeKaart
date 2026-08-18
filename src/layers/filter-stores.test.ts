import { describe, expect, it, beforeEach } from "vitest";
import { createEffect, createRoot } from "solid-js";

import { boxFilter, setBoxFilter } from "@/layers/box-filter";
import {
  areaFilterLevels,
  featureMatchesAreaFilter,
  isAreaFilterActive,
  setAreaFilterSelection,
} from "@/layers/area-filter";
import { filterEpoch } from "@/layers/chart-data";

/**
 * The filter stores are the clearest thing the SolidJS port changed: they used
 * to be plain module objects plus a `version` counter that existed only so a
 * React component could hold a scalar cache key. These tests assert the two
 * properties that replaced it — a store mutation propagates to observers on its
 * own, and it is visible to a synchronous reader immediately.
 */

beforeEach(() => {
  setBoxFilter(null);
  setAreaFilterSelection(new Map());
});

/** Let Solid flush its effect queue. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("box filter store", () => {
  it("notifies an observer without any manual mirror", async () => {
    const seen: Array<[number, number, number, number] | null> = [];
    let dispose = () => {};
    createRoot((d) => {
      dispose = d;
      createEffect(() => seen.push(boxFilter()));
    });

    await tick();
    expect(seen).toEqual([null]);

    setBoxFilter([4, 51, 6, 53]);
    await tick();
    expect(seen).toEqual([null, [4, 51, 6, 53]]);

    setBoxFilter(null);
    await tick();
    expect(seen).toEqual([null, [4, 51, 6, 53], null]);

    dispose();
  });

  it("is readable synchronously by a caller outside any reactive scope", () => {
    // This is what the imperative side depends on: a `moveend` listener or a
    // worker completion reads the accessor directly, with no tracking context.
    setBoxFilter([0, 0, 1, 1]);
    expect(boxFilter()).toEqual([0, 0, 1, 1]);
  });
});

describe("area filter store", () => {
  it("commits a selection and reports it through every reader shape", () => {
    expect(isAreaFilterActive()).toBe(false);

    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0882"])]]));

    expect(isAreaFilterActive()).toBe(true);
    expect(areaFilterLevels()).toHaveLength(1);
    expect(featureMatchesAreaFilter({ gm_code: "GM0882" })).toBe(true);
    expect(featureMatchesAreaFilter({ gm_code: "GM0900" })).toBe(false);
  });

  it("matches a finer code against a coarser selection by digit prefix", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0882"])]]));
    // A buurt inside gemeente 0882: no gm_code column, so the hierarchy
    // fallback compares digit prefixes.
    expect(featureMatchesAreaFilter({ bu_code: "BU08820101" })).toBe(true);
    expect(featureMatchesAreaFilter({ bu_code: "BU09000101" })).toBe(false);
  });

  it("drops empty levels so an empty selection deactivates the filter", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set<string>()]]));
    expect(areaFilterLevels()).toHaveLength(0);
    expect(isAreaFilterActive()).toBe(false);
  });

  it("allocates a fresh levels array per commit, which invalidates the caches", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0882"])]]));
    const first = areaFilterLevels();
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0882"])]]));
    // Same content, new identity: the per-batch column caches key on identity
    // now that the version counter is gone.
    expect(areaFilterLevels()).not.toBe(first);
  });
});

describe("filterEpoch", () => {
  it("advances when either store changes and holds still otherwise", () => {
    const start = filterEpoch();
    expect(filterEpoch()).toBe(start);

    setBoxFilter([1, 1, 2, 2]);
    const afterBox = filterEpoch();
    expect(afterBox).toBeGreaterThan(start);

    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0882"])]]));
    expect(filterEpoch()).toBeGreaterThan(afterBox);
  });
});
