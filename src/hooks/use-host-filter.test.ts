import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

import { useHostFilter } from "@/hooks/use-host-filter";
import type { AreaFilterOption, AreaFilterState } from "@/hooks/use-area-filter";
import type { AreaFilterEntry } from "@/layers/area-filter";
import type { ViewState } from "@/components/map/map-view-config";

/**
 * The host `filter` message is the gebiedsfilter's one wire contract, and it
 * was the only scalar step left in an otherwise multi-code pipeline: the store,
 * the MapLibre expression and the outline geometry all take a Set already.
 *
 * So these tests pin the widening itself — a level may carry one code/label or
 * an array of them — plus the three behaviours around it that are easy to break
 * and silent when broken: the SINGLE applySelections commit, the clear that
 * cascades to finer levels, and the fly-back to the default view once nothing
 * is selected. A bare string must keep behaving exactly as before, because the
 * Power BI visual in the other repo still sends one.
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
];

const OPTIONS: Record<string, AreaFilterOption[]> = {
  gm_code: [
    { code: "GM0983", label: "Venlo", parents: {} },
    { code: "GM0984", label: "Venray", parents: {} },
    { code: "GM0888", label: "Beek (L.)", parents: {} },
  ],
  wk_code: [
    { code: "WK098301", label: "Venlo-Centrum", parents: { gm_code: "GM0983" } },
    { code: "WK098401", label: "Venray-Centrum", parents: { gm_code: "GM0984" } },
  ],
};

const INITIAL_VIEW = { longitude: 5.9, latitude: 51.2, zoom: 8 } as ViewState;

interface Harness {
  setFilter: (filter: Record<string, string | string[] | null>) => void;
  /** Every applySelections call, as plain code arrays per level. */
  commits: Record<string, string[]>[];
  views: { center: [number, number]; zoom: number }[];
  selected: Map<string, Set<string>>;
}

function harness(opts?: { entries?: AreaFilterEntry[] }): Harness {
  const entries = opts?.entries ?? ENTRIES;
  const commits: Harness["commits"] = [];
  const views: Harness["views"] = [];
  // The committed selection, which optionsFor() narrows against on the next
  // message — the real hook seeds each pass from it.
  const selected = new Map<string, Set<string>>();

  const areaFilter: AreaFilterState = {
    entries: () => entries,
    optionsFor: (entry, against = selected) => {
      const all = OPTIONS[entry.key] ?? [];
      const index = entries.indexOf(entry);
      for (let i = index - 1; i >= 0; i--) {
        const ancestor = entries[i];
        const codes = against.get(ancestor.key);
        if (!codes || codes.size === 0) continue;
        return all.filter((o) => codes.has(o.parents[ancestor.key] ?? ""));
      }
      return all;
    },
    isEnabled: () => true,
    selections: () => selected,
    setValue: () => {
      throw new Error("setFilterFromHost must not call setValue");
    },
    clearLevel: () => {
      throw new Error("setFilterFromHost must not call clearLevel");
    },
    applySelections: (next) => {
      const snapshot: Record<string, string[]> = {};
      for (const [key, codes] of next) snapshot[key] = [...codes];
      commits.push(snapshot);
      selected.clear();
      for (const [key, codes] of next) selected.set(key, new Set(codes));
    },
  };

  return createRoot(() => ({
    setFilter: useHostFilter({
      areaFilter,
      applyView: (view) =>
        views.push(view as { center: [number, number]; zoom: number }),
      initialViewState: INITIAL_VIEW,
    }),
    commits,
    views,
    selected,
  }));
}

beforeEach(() => vi.restoreAllMocks());

describe("useHostFilter — one value", () => {
  it("still accepts a bare code, as the Power BI visual sends", () => {
    const h = harness();
    h.setFilter({ Gemeente: "GM0983" });

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
  });

  it("resolves a display label too, case-insensitively", () => {
    const h = harness();
    h.setFilter({ Gemeente: "venlo" });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
  });

  it("matches the level name case-insensitively", () => {
    const h = harness();
    h.setFilter({ gemeente: "GM0983" });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
  });
});

describe("useHostFilter — several values", () => {
  it("resolves an array into one multi-code level", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983", "GM0984"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983", "GM0984"]);
  });

  it("mixes codes and labels in one array", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983", "Venray"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983", "GM0984"]);
  });

  it("de-duplicates a code sent twice, by code and by label", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983", "Venlo"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
  });

  // A regenerated gebieden.json can leave a stale code in a visitor's
  // sessionStorage. One bad value must not cost the whole selection.
  it("skips an unresolvable value and applies the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983", "GM9999"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  // Clearing the level instead would widen the map to everything, which reads
  // as "the filter broke" rather than "that area is unknown".
  it("leaves a level untouched when every value is unresolvable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"] });
    h.setFilter({ Gemeente: ["GM9999"] });

    expect(h.commits[1].gm_code).toEqual(["GM0983"]);
  });

  it("narrows a finer level by every selected ancestor in the same message", () => {
    const h = harness();
    h.setFilter({
      Gemeente: ["GM0983", "GM0984"],
      Wijk: ["WK098301", "WK098401"],
    });

    // Both wijken resolve: each one's parent is among the gemeenten decided
    // earlier in this same coarse-to-fine pass.
    expect(h.commits[0].wk_code).toEqual(["WK098301", "WK098401"]);
  });

  it("drops a wijk outside the gemeenten of the same message", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"], Wijk: ["WK098401"] });

    // Venray's wijk is not an option under Venlo, so it is skipped and the
    // level keeps whatever it had (nothing).
    expect(h.commits[0].wk_code ?? []).toEqual([]);
  });
});

describe("useHostFilter — clearing", () => {
  it("treats null as a clear", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"] });
    h.setFilter({ Gemeente: null });

    expect(h.commits[1].gm_code).toEqual([]);
  });

  it("treats an empty array as a clear", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"] });
    h.setFilter({ Gemeente: [] });

    expect(h.commits[1].gm_code).toEqual([]);
  });

  it("ignores empty strings mixed in with real codes", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["", "GM0983"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
  });

  it("cascades a clear to every finer level", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"], Wijk: ["WK098301"] });
    h.setFilter({ Gemeente: null });

    expect(h.commits[1].gm_code).toEqual([]);
    expect(h.commits[1].wk_code).toEqual([]);
  });

  it("flies back to the default view once nothing is selected", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"] });
    expect(h.views).toHaveLength(0);

    h.setFilter({ Gemeente: [] });
    expect(h.views).toEqual([
      { center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude], zoom: INITIAL_VIEW.zoom },
    ]);
  });
});

describe("useHostFilter — commit discipline", () => {
  // Load-bearing: applySelections rebuilds from the current selection, so one
  // call per level would make each discard the previous one's result — the bug
  // that re-flew to a Buurt that had just been unpicked.
  it("commits once per message, however many levels it names", () => {
    const h = harness();
    h.setFilter({
      Gemeente: ["GM0983", "GM0984"],
      Wijk: ["WK098301", "WK098401"],
    });

    expect(h.commits).toHaveLength(1);
  });

  it("warns about an unknown level but still applies the known ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"], Provincie: ["PV31"] });

    expect(h.commits[0].gm_code).toEqual(["GM0983"]);
    expect(warn).toHaveBeenCalledWith(
      'filter: unknown level "Provincie" (skipped)',
    );
  });

  // Messages can arrive before the parquet option tables resolve (in embed mode
  // the map-ready handshake fires immediately), so they are queued, not dropped.
  it("queues a message that arrives before the options load", () => {
    const h = harness({ entries: [] });
    h.setFilter({ Gemeente: ["GM0983"] });

    expect(h.commits).toHaveLength(0);
  });

  it("leaves levels the message does not name alone", () => {
    const h = harness();
    h.setFilter({ Gemeente: ["GM0983"], Wijk: ["WK098301"] });
    h.setFilter({ Wijk: ["WK098301"] });

    expect(h.commits[1].gm_code).toEqual(["GM0983"]);
  });
});
