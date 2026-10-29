import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";

import { useHostFilter } from "@/hooks/use-host-filter";
import {
  areaFilterExpression,
  featureMatchesAreaFilter,
  setAreaFilterSelection,
} from "@/layers/area-filter";
import type { AreaFilterOption, AreaFilterState } from "@/hooks/use-area-filter";
import type { AreaFilterEntry } from "@/layers/area-filter";
import type { ViewState } from "@/components/map/map-view-config";

/**
 * The whole bridge, in one pass: the exact `filter` payload the landing page's
 * gebiedsfilter posts (`kaart-pane.js`, arrays of CBS codes per level) through
 * useHostFilter and into the module store the map actually renders from.
 *
 * The unit tests either side of this cover the halves; this one exists because
 * the two were specified independently — the landing page sends arrays only
 * because the hook accepts them, and nothing else pins that agreement. A
 * regression here shows up as a map that silently filters on one gemeente out
 * of five.
 */

const ENTRIES: AreaFilterEntry[] = [
  {
    name: "Gemeente",
    source: "gemeente.parquet",
    key: "gm_code",
    label: "statnaam",
    placeholder: "Alle gemeenten",
    dependsOn: [],
  },
  {
    name: "Wijk",
    source: "wijk.parquet",
    key: "wk_code",
    label: "statnaam",
    placeholder: "Alle wijken",
    dependsOn: ["Gemeente"],
  },
  {
    name: "Buurt",
    source: "buurt.parquet",
    key: "bu_code",
    label: "statnaam",
    placeholder: "Alle buurten",
    dependsOn: ["Gemeente", "Wijk"],
  },
];

// Venlo and Venray, as gebieden.json holds them.
const OPTIONS: Record<string, AreaFilterOption[]> = {
  gm_code: [
    { code: "GM0983", label: "Venlo", parents: {} },
    { code: "GM0984", label: "Venray", parents: {} },
  ],
  wk_code: [
    { code: "WK098301", label: "Venlo-Centrum", parents: { gm_code: "GM0983" } },
    { code: "WK098401", label: "Venray-Centrum", parents: { gm_code: "GM0984" } },
  ],
  bu_code: [
    {
      code: "BU09830101",
      label: "Venlo-Binnenstad",
      parents: { gm_code: "GM0983", wk_code: "WK098301" },
    },
  ],
};

/**
 * The real hook, wired to a store that commits into the module-level selection
 * the renderer reads — i.e. applySelections' real side effect.
 */
function bridge() {
  const selected = new Map<string, Set<string>>();
  const areaFilter: AreaFilterState = {
    entries: () => ENTRIES,
    optionsFor: (entry, against = selected) => {
      const all = OPTIONS[entry.key] ?? [];
      const index = ENTRIES.indexOf(entry);
      for (let i = index - 1; i >= 0; i--) {
        const ancestor = ENTRIES[i];
        const codes = against.get(ancestor.key);
        if (!codes || codes.size === 0) continue;
        return all.filter((o) => codes.has(o.parents[ancestor.key] ?? ""));
      }
      return all;
    },
    isEnabled: () => true,
    selections: () => selected,
    setValue: () => {},
    clearLevel: () => {},
    applySelections: (next) => {
      selected.clear();
      for (const [key, codes] of next) selected.set(key, new Set(codes));
      // What useAreaFilter.commit() does, and the only part the map sees.
      setAreaFilterSelection(next);
    },
  };

  return createRoot(() =>
    useHostFilter({
      areaFilter,
      applyView: () => {},
      initialViewState: { longitude: 5.9, latitude: 51.2, zoom: 8 } as ViewState,
    }),
  );
}

describe("landing page -> map gebiedsfilter bridge", () => {
  it("renders every gemeente of a multi-select as one filter", () => {
    const setFilter = bridge();

    // Exactly what kaart-pane.js posts for "Venlo + Venray".
    setFilter({ Gemeente: ["GM0983", "GM0984"], Wijk: null, Buurt: null });

    // Both pass the filter the tiles are drawn with...
    expect(featureMatchesAreaFilter({ gm_code: "GM0983" })).toBe(true);
    expect(featureMatchesAreaFilter({ gm_code: "GM0984" })).toBe(true);
    // ...and a third gemeente does not.
    expect(featureMatchesAreaFilter({ gm_code: "GM0888" })).toBe(false);

    // Both codes reach the MapLibre expression, not just the first.
    const expr = JSON.stringify(areaFilterExpression());
    expect(expr).toContain("GM0983");
    expect(expr).toContain("GM0984");
  });

  it("carries a multi-wijk selection under several gemeenten", () => {
    const setFilter = bridge();

    setFilter({
      Gemeente: ["GM0983", "GM0984"],
      Wijk: ["WK098301", "WK098401"],
      Buurt: null,
    });

    expect(
      featureMatchesAreaFilter({ gm_code: "GM0983", wk_code: "WK098301" }),
    ).toBe(true);
    expect(
      featureMatchesAreaFilter({ gm_code: "GM0984", wk_code: "WK098401" }),
    ).toBe(true);
    // A wijk of neither gemeente is out.
    expect(
      featureMatchesAreaFilter({ gm_code: "GM0983", wk_code: "WK088200" }),
    ).toBe(false);
  });

  // The landing page sends null for a level it has nothing selected at, every
  // time — so "clear" must survive the trip, or an area the visitor left would
  // keep filtering.
  it("clears a level the payload nulls, and the finer ones with it", () => {
    const setFilter = bridge();

    setFilter({
      Gemeente: ["GM0983"],
      Wijk: ["WK098301"],
      Buurt: ["BU09830101"],
    });
    expect(featureMatchesAreaFilter({ bu_code: "BU09830101" })).toBe(true);

    setFilter({ Gemeente: null, Wijk: null, Buurt: null });

    // Nothing selected: the filter is inactive and everything draws again.
    expect(areaFilterExpression()).toBeNull();
    expect(featureMatchesAreaFilter({ gm_code: "GM0888" })).toBe(true);
  });

  // kaart-pane.js falls back to the singular key when a payload predates the
  // multi-select build; the map must still filter on it.
  it("accepts the legacy single-code payload", () => {
    const setFilter = bridge();

    setFilter({ Gemeente: "GM0983", Wijk: null, Buurt: null });

    expect(featureMatchesAreaFilter({ gm_code: "GM0983" })).toBe(true);
    expect(featureMatchesAreaFilter({ gm_code: "GM0984" })).toBe(false);
  });
});
