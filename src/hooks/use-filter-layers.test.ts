import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";

const computeScoreGrid = vi.hoisted(() => vi.fn());

vi.mock("@/layers/filter-raster", () => ({
  computeScoreGrid,
}));
// A working registry rather than bare spies: a combination used as a criterion
// is scored from the grid its source registered.
const registered = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/layers/score-protocol", () => ({
  registerScoreGrid: vi.fn((id: string, grid: unknown) => registered.set(id, grid)),
  getScoreGrid: (id: string) => registered.get(id),
  unregisterScoreGrid: vi.fn((id: string) => registered.delete(id)),
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
        () => 2040,
      );
      expect(requestedUrls()).toEqual(["https://example.test/huisarts_lb_m5.cog.tif"]);
      dispose();
    });
  });
});

/**
 * Rebuilding a combination that arrived in a share link. The step comes from
 * the stored definition, not from this session — a recipient stepped to a
 * different year must still see the year the sender combined.
 */
describe("useFilterLayers.restore", () => {
  const DEF = {
    id: "filter__9",
    name: "Gedeelde combinatie",
    refs: [{ layerId: "aandeel_j0_17", ruleName: "0-10%" }],
    classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
    steps: { aandeel_j0_17: 2040 },
  };

  it("scores the year stored in the definition", async () => {
    await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      await hook.restore([DEF], [aandeelLayer()]);
      dispose();
    });

    expect(requestedUrls()).toEqual([
      "https://example.test/aandeel_j0_17_m5_2040.cog.tif",
    ]);
  });

  it("keeps the incoming id when it is free, so the link's add command finds it", async () => {
    const remapped = await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      const result = await hook.restore([DEF], [aandeelLayer()]);
      dispose();
      return result;
    });

    expect(remapped.get("filter__9")).toBe("filter__9");
    expect(getFilterLayers().map((def) => def.id)).toEqual(["filter__9"]);
  });

  it("remaps rather than overwriting a combination the recipient already built", async () => {
    const remapped = await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      await hook.restore([DEF], [aandeelLayer()]);
      // The same id arrives again, from someone else's session.
      const result = await hook.restore(
        [{ ...DEF, name: "Andermans combinatie" }],
        [aandeelLayer()],
      );
      dispose();
      return result;
    });

    const stored = getFilterLayers();
    expect(remapped.get("filter__9")).not.toBe("filter__9");
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: "filter__9", name: "Gedeelde combinatie" });
    expect(stored[1].name).toBe("Andermans combinatie");
  });

  it("skips a definition whose source layer is absent instead of throwing", async () => {
    const remapped = await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      // Empty catalogue: the recipient's variant has no such layer.
      const result = await hook.restore([DEF], []);
      dispose();
      return result;
    });

    expect(remapped.size).toBe(0);
    expect(getFilterLayers()).toHaveLength(0);
    expect(computeScoreGrid).not.toHaveBeenCalled();
  });
});

/**
 * Editing a combination in place. The id must survive, since the map, share
 * links and the nav theme all hold it, and a failed grid computation must
 * leave the old combination exactly as it was.
 */
describe("useFilterLayers.update", () => {
  const REF = { layerId: "aandeel_j0_17", ruleName: "0-10%" };

  it("keeps the id and scores the step it is given", async () => {
    await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      await hook.create("Oud", [REF], [aandeelLayer()], () => 2030);
      const id = getFilterLayers()[0].id;
      computeScoreGrid.mockClear();

      const def = await hook.update(
        id,
        "Nieuw",
        [REF],
        [aandeelLayer()],
        () => 2030,
        [{ label: "één", color: "#123456" }],
      );

      expect(def).toHaveLength(1);
      expect(def?.[0]).toMatchObject({ id, name: "Nieuw", steps: { aandeel_j0_17: 2030 } });
      expect(getFilterLayers()).toHaveLength(1);
      expect(hook.defs()[0].name).toBe("Nieuw");
      expect(requestedUrls()).toEqual(["https://example.test/aandeel_j0_17_m5_2030.cog.tif"]);
      dispose();
    });
  });

  it("leaves the old combination untouched when the grid fails", async () => {
    await createRoot(async (dispose) => {
      const hook = useFilterLayers(
        async () => {},
        () => {},
      );
      await hook.create("Oud", [REF], [aandeelLayer()], () => 2030);
      const before = getFilterLayers()[0];
      computeScoreGrid.mockRejectedValueOnce(new Error("boom"));

      const def = await hook.update(before.id, "Nieuw", [REF], [aandeelLayer()], () => 2040, []);

      expect(def).toBeUndefined();
      expect(getFilterLayers()[0]).toEqual(before);
      expect(hook.error()).toBe("Kon de gecombineerde laag niet aanpassen.");
      dispose();
    });
  });
});

/**
 * A combination used as a criterion of another. It is scored from its source's
 * registered grid, follows that source's edits, and travels in share links
 * with its source.
 */
describe("combinations as criteria", () => {
  const AANDEEL = { layerId: "aandeel_j0_17", ruleName: "0-10%" };
  const HUISARTS = { layerId: "huisarts", ruleName: "0-10%" };

  function huisartsLayer(): LayerConfig {
    return {
      ...aandeelLayer(),
      id: "huisarts",
      timeseries: undefined,
      filterRaster: "https://example.test/huisarts_lb_m5.cog.tif",
    } as LayerConfig;
  }

  const CONFIGS = () => [aandeelLayer(), huisartsLayer()];

  /** A distinct grid per call, so a test can tell which one an input carries. */
  function gridNamed(name: string) {
    return { width: 1, height: 1, data: new Uint8Array([1]), bbox: [0, 0, 1, 1], filterCount: 1, name };
  }

  function hook() {
    return useFilterLayers(
      async () => {},
      () => {},
    );
  }

  /** Inputs of the n-th computeScoreGrid call. */
  function inputsOf(call: number) {
    return computeScoreGrid.mock.calls[call][0] as { url?: string; grid?: unknown; filter: unknown }[];
  }

  beforeEach(() => registered.clear());

  it("scores a combination criterion from its source's registered grid", async () => {
    await createRoot(async (dispose) => {
      const filters = hook();
      computeScoreGrid.mockResolvedValueOnce(gridNamed("A"));
      await filters.create("A", [AANDEEL], CONFIGS(), () => 2030);
      const a = getFilterLayers()[0];

      await filters.create(
        "B",
        [{ layerId: a.id, ruleName: "1 van 1 criteria", score: 1 }, HUISARTS],
        CONFIGS(),
        () => undefined,
      );

      const inputs = inputsOf(1);
      expect(inputs[0]).toEqual({ grid: gridNamed("A"), filter: ["==", "band0", 1] });
      expect(inputs[1].url).toBe("https://example.test/huisarts_lb_m5.cog.tif");
      dispose();
    });
  });

  it("recomputes the combinations built on an edited one, from its new grid", async () => {
    await createRoot(async (dispose) => {
      const filters = hook();
      await filters.create("A", [AANDEEL], CONFIGS(), () => 2030);
      const a = getFilterLayers()[0];
      await filters.create(
        "B",
        [{ layerId: a.id, ruleName: "1 van 1 criteria", score: 1 }, HUISARTS],
        CONFIGS(),
        () => undefined,
      );
      const b = getFilterLayers()[1];
      computeScoreGrid.mockClear();
      computeScoreGrid.mockResolvedValueOnce(gridNamed("A2"));

      const changed = await filters.update(a.id, "A", [AANDEEL], CONFIGS(), () => 2040, a.classes);

      expect(changed?.map((def) => def.id)).toEqual([a.id, b.id]);
      // B was rescored from A's NEW grid.
      expect(inputsOf(1)[0].grid).toEqual(gridNamed("A2"));
      expect(filters.notice()).toBeNull();
      dispose();
    });
  });

  it("drops a class whose score vanished, resets the legend, and says so", async () => {
    await createRoot(async (dispose) => {
      const filters = hook();
      await filters.create("A", [AANDEEL, HUISARTS], CONFIGS(), () => 2030);
      const a = getFilterLayers()[0];
      // B wants "2 van 2" of A, plus a criterion of its own.
      await filters.create(
        "B",
        [{ layerId: a.id, ruleName: "2 van 2 criteria", score: 2 }, HUISARTS],
        CONFIGS(),
        () => undefined,
      );
      const b = getFilterLayers()[1];
      expect(b.classes).toHaveLength(2);

      // A shrinks to one criterion: its score 2 no longer exists.
      const changed = await filters.update(
        a.id,
        "A",
        [AANDEEL],
        CONFIGS(),
        () => 2030,
        [{ label: "1 van 1 criteria", color: "#3288bd" }],
      );

      const updatedB = changed?.find((def) => def.id === b.id);
      expect(updatedB?.refs).toEqual([HUISARTS]);
      expect(updatedB?.classes).toHaveLength(1);
      expect(filters.notice()).toMatch(/"B": een criterium is vervallen/);
      dispose();
    });
  });

  it("points a restored dependent at its source's remapped id", async () => {
    await createRoot(async (dispose) => {
      const filters = hook();
      // The recipient already holds a combination under the id the link uses.
      await filters.create("Eigen", [HUISARTS], CONFIGS(), () => undefined);
      const taken = getFilterLayers()[0].id;

      const source = {
        id: taken,
        name: "Bron",
        refs: [AANDEEL],
        classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
        steps: { aandeel_j0_17: 2030 },
      };
      const dependent = {
        id: "filter__500",
        name: "Afgeleid",
        refs: [{ layerId: taken, ruleName: "1 van 1 criteria", score: 1 }],
        classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
      };

      const remap = await filters.restore([source, dependent], CONFIGS());

      const sourceId = remap.get(taken)!;
      expect(sourceId).not.toBe(taken);
      const stored = getFilterLayers().find((def) => def.id === remap.get("filter__500"));
      expect(stored?.refs[0].layerId).toBe(sourceId);
      dispose();
    });
  });

  it("skips a restored dependent whose source is not in the link", async () => {
    await createRoot(async (dispose) => {
      const filters = hook();
      const orphan = {
        id: "filter__600",
        name: "Wees",
        refs: [{ layerId: "filter__601", ruleName: "1 van 1 criteria", score: 1 }],
        classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
      };

      const remap = await filters.restore([orphan], CONFIGS());

      expect(remap.has("filter__600")).toBe(false);
      expect(getFilterLayers()).toEqual([]);
      dispose();
    });
  });
});
