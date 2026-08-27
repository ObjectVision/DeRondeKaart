import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearLayerConfigCache } from "@/layers/config";
import { leafPair, type NavLeaf } from "@/layers/navigation";
import { useNavigation } from "./use-navigation";
import { useLayerPairs } from "./use-layer-pairs";

/**
 * Two layers, both resolvable from layers.json, so a pair can put one on each
 * map. Ids match the shipped config's numeric style.
 */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      statusText: "OK",
      json: async () =>
        url.endsWith("layers.json")
          ? {
              layers: [
                { id: "235", name: "Energieverbruik (R23 H01)", format: "mvt", source: "x" },
                { id: "240", name: "Energieverbruik (R30 H01)", format: "mvt", source: "y" },
              ],
            }
          : [],
    })),
  );
}

/**
 * A map side shaped like useMapLayers' result, recording what lands on it.
 *
 * `addLayer` is async on purpose: the real one awaits a format load, and the
 * ordering this hook depends on only breaks when the awaits are real.
 */
function fakeSide() {
  let entries: { config: { id: string } }[] = [];
  const addLayer = vi.fn(async (config: { id: string }) => {
    await Promise.resolve();
    if (!entries.some((e) => e.config.id === config.id)) entries = [...entries, { config }];
  });
  const removeLayer = vi.fn((id: string) => {
    entries = entries.filter((e) => e.config.id !== id);
  });
  return {
    // The stack only needs the three members useNavigation touches; `as never`
    // keeps the rest of UseMapLayersResult out of the fixture. The spies are
    // re-exposed above the cast so tests can drive them without casting back.
    layers: { layerEntries: () => entries, addLayer, removeLayer } as never,
    addLayer,
    removeLayer,
    ids: () => entries.map((e) => e.config.id),
  };
}

function setup() {
  const left = fakeSide();
  const right = fakeSide();
  return { left, right, nav: useNavigation({ left, right }) };
}

const PAIR = { left: "235", right: "240" };

describe("leafPair", () => {
  const base: NavLeaf = { id: "x", label: "X" };

  it("reads a leaf naming both sides", () => {
    expect(leafPair({ ...base, left: "235", right: "240" })).toEqual(PAIR);
  });

  // Half a pair would put one layer on one map and call it a comparison.
  it("is null when only one side is named", () => {
    expect(leafPair({ ...base, left: "235" })).toBeNull();
    expect(leafPair({ ...base, right: "240" })).toBeNull();
  });

  it("is null for an ordinary leaf, including the vestigial a/b booleans", () => {
    expect(leafPair(base)).toBeNull();
    expect(leafPair({ ...base, a: false, b: false })).toBeNull();
  });
});

describe("useNavigation pairs", () => {
  beforeEach(() => {
    stubFetch();
    clearLayerConfigCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("puts the left layer on the left map and the right layer on the right", async () => {
    const { left, right, nav } = setup();

    await nav.togglePair(PAIR);

    expect(left.ids()).toEqual(["235"]);
    expect(right.ids()).toEqual(["240"]);
    expect(nav.pairState(PAIR)).toBe("both");
  });

  /**
   * The regression this guards: the right map refuses layers while the left is
   * empty (comparison is left-anchored). Awaiting the left add before starting
   * the right one is what keeps the pair whole — firing both at once lets the
   * right add observe the left map as it was before its layer landed.
   */
  it("has the left layer on the map before the right one is added", async () => {
    const { left, right, nav } = setup();
    let leftCountWhenRightAdded = -1;
    right.addLayer.mockImplementation(async () => {
      leftCountWhenRightAdded = left.ids().length;
    });

    await nav.togglePair(PAIR);

    expect(leftCountWhenRightAdded).toBe(1);
  });

  it("clears both layers on a second toggle", async () => {
    const { left, right, nav } = setup();

    await nav.togglePair(PAIR);
    await nav.togglePair(PAIR);

    expect(left.ids()).toEqual([]);
    expect(right.ids()).toEqual([]);
    expect(nav.pairState(PAIR)).toBe("none");
  });

  // The user can remove one half from the legend; the row must then clear the
  // leftover rather than toggling the missing half back on.
  it("recovers a half-applied pair to empty", async () => {
    const { left, right, nav } = setup();
    await nav.togglePair(PAIR);
    right.removeLayer("240");
    expect(nav.pairState(PAIR)).toBe("partial");

    await nav.togglePair(PAIR);

    expect(left.ids()).toEqual([]);
    expect(right.ids()).toEqual([]);
  });

  it("leaves single-layer toggling alone", async () => {
    const { left, right, nav } = setup();

    await nav.toggleOnMap("235", "left");

    expect(left.ids()).toEqual(["235"]);
    expect(right.ids()).toEqual([]);
  });
});

/**
 * Recording the pair is what lets the legend keep the two halves together
 * afterwards. Without it the layers land on the maps as two strangers.
 */
describe("useNavigation pair bookkeeping", () => {
  beforeEach(() => {
    clearLayerConfigCache();
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  function setupWithPairs() {
    const left = fakeSide();
    const right = fakeSide();
    const pairs = useLayerPairs((id, side) =>
      (side === "left" ? left : right).ids().includes(id),
    );
    return { left, right, pairs, nav: useNavigation({ left, right, pairs }) };
  }

  it("records the pair once both halves are on the maps", async () => {
    const { pairs, nav } = setupWithPairs();

    await nav.togglePair(PAIR);

    expect(pairs.pairFor("235", "left")).toEqual(PAIR);
    expect(pairs.isPaired("240", "right")).toBe(true);
  });

  it("forgets the pair when the leaf is toggled off", async () => {
    const { pairs, nav } = setupWithPairs();
    await nav.togglePair(PAIR);

    await nav.togglePair(PAIR);

    expect(pairs.pairs()).toHaveLength(0);
  });

  /**
   * A pair that only half-applied is not a comparison. Recording it would tie
   * the surviving layer to a partner that never made it onto the map.
   */
  it("records nothing when half the pair cannot be resolved", async () => {
    const left = fakeSide();
    const right = fakeSide();
    const pairs = useLayerPairs((id, side) =>
      (side === "left" ? left : right).ids().includes(id),
    );
    const nav = useNavigation({ left, right, pairs });

    // "999" is not in the stubbed layers.json, so the right half never lands.
    await nav.togglePair({ left: "235", right: "999" });

    expect(left.ids()).toEqual(["235"]);
    expect(right.ids()).toEqual([]);
    expect(pairs.pairs()).toHaveLength(0);
  });

  it("does not pair layers added individually", async () => {
    const { pairs, nav } = setupWithPairs();

    await nav.toggleOnMap("235", "left");
    await nav.toggleOnMap("240", "right");

    expect(pairs.isPaired("235", "left")).toBe(false);
  });
});
