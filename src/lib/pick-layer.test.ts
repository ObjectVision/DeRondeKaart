import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { addPickLayer } from "@/lib/pick-layer";
import { clearConfigCache } from "@/config/load-config";
import { initVariants } from "@/config/variant";
import type { MapSide } from "@/lib/map-side";

/**
 * The pick layer is invisible and absent from the legend and navigation tree,
 * so nothing on screen says whether it is there. When it is missing the map
 * simply stops answering clicks — which is exactly how the right map shipped
 * broken: it was only ever added to the left.
 */

const PICK_LAYER = {
  id: "buurt_klik",
  name: "Buurten",
  format: "pmtiles",
  source: "https://example.invalid/x.pmtiles",
  sourceLayer: "x",
  excludeFromComparison: true,
  featureinfo: { pbl: true },
};

function stubLayers(layers: unknown[] = [PICK_LAYER]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ layers }),
    })),
  );
}

/** A side whose stack records what it was asked to add. */
function fakeSide() {
  const added: string[] = [];
  const addLayer = vi.fn(async (config: { id: string }) => {
    // Mirrors useMapLayers: idempotent on id.
    if (!added.includes(config.id)) added.push(config.id);
  });
  const syncImperativeLayers = vi.fn();
  return {
    side: { layers: { addLayer, syncImperativeLayers } } as unknown as MapSide,
    added,
    addLayer,
    syncImperativeLayers,
  };
}

describe("addPickLayer", () => {
  beforeEach(() => {
    clearConfigCache();
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds the configured layer to the side it is given", async () => {
    stubLayers();
    const { side, added, addLayer } = fakeSide();

    await addPickLayer(side, "buurt_klik");

    expect(added).toEqual(["buurt_klik"]);
    // atEnd: the pick layer belongs at the bottom of the draw order, not seeded
    // into its config's band.
    expect(addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "buurt_klik" }),
      { atEnd: true },
    );
  });

  // The bug this fixes: each map queries only its own stack, so the right map
  // needs its own entry or clicks there find nothing.
  it("gives each map its own entry", async () => {
    stubLayers();
    const left = fakeSide();
    const right = fakeSide();

    await addPickLayer(left.side, "buurt_klik");
    await addPickLayer(right.side, "buurt_klik");

    expect(left.added).toEqual(["buurt_klik"]);
    expect(right.added).toEqual(["buurt_klik"]);
  });

  // The right map is conditionally mounted, so this runs again on every mount.
  it("adds nothing the second time for the same map", async () => {
    stubLayers();
    const { side, added, addLayer } = fakeSide();

    await addPickLayer(side, "buurt_klik");
    await addPickLayer(side, "buurt_klik");

    expect(added).toEqual(["buurt_klik"]);
    expect(addLayer).toHaveBeenCalledTimes(2); // idempotence is addLayer's job
  });

  it("replays imperative layers so a fresh style keeps the entry", async () => {
    stubLayers();
    const { side, syncImperativeLayers } = fakeSide();

    await addPickLayer(side, "buurt_klik");

    expect(syncImperativeLayers).toHaveBeenCalled();
  });

  /**
   * The right map is rendered only while it holds a layer that counts as
   * comparison content:
   *
   *   showMapRight = layerEntries().some((e) => !e.config.excludeFromComparison)
   *
   * A pick layer without `excludeFromComparison` would satisfy that on its own,
   * so adding one to the right map would force the split view and the slider
   * open with nothing to compare — and keep them open. This asserts the flag
   * that prevents it, on the config as loaded.
   */
  it("adds a layer that cannot by itself turn comparison mode on", async () => {
    stubLayers();
    const { side, addLayer } = fakeSide();

    await addPickLayer(side, "buurt_klik");

    expect(addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ excludeFromComparison: true }),
      expect.anything(),
    );
  });

  it("does nothing when map.json names no pick layer", async () => {
    stubLayers();
    const { side, addLayer } = fakeSide();

    await addPickLayer(side, undefined);

    expect(addLayer).not.toHaveBeenCalled();
  });

  it("warns and adds nothing when the id is not in layers.json", async () => {
    stubLayers([{ id: "iets_anders", name: "x", format: "mvt", source: "y" }]);
    const { side, addLayer } = fakeSide();

    await addPickLayer(side, "buurt_klik");

    expect(addLayer).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('pickLayer "buurt_klik" not found'),
    );
  });

  /**
   * The right map can name its own pick layer (map.json `pickLayerRight`), used
   * where the two maps show different datasets — the 2025_2026 variant, whose
   * right map is 2026 while the left is 2025.
   */
  describe("per-side pick layer", () => {
    const PICK_2026 = { ...PICK_LAYER, id: "buurt_klik_2026" };

    it("prefers the right map's own layer when it exists", async () => {
      stubLayers([PICK_LAYER, PICK_2026]);
      const { side, added } = fakeSide();

      await addPickLayer(side, "buurt_klik_2026", "buurt_klik");

      expect(added).toEqual(["buurt_klik_2026"]);
    });

    /**
     * The regression this guards: map.json is SHARED across variants, so
     * `pickLayerRight: "buurt_klik_2026"` also applies to the 2025 and 2026
     * variants, where that layer does not exist. Without the fallback the right
     * map would get no pick layer at all and silently stop answering clicks.
     */
    it("falls back to the left map's layer where the right one is absent", async () => {
      stubLayers([PICK_LAYER]);
      const { side, added } = fakeSide();

      await addPickLayer(side, "buurt_klik_2026", "buurt_klik");

      expect(added).toEqual(["buurt_klik"]);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("warns only when neither id resolves", async () => {
      stubLayers([]);
      const { side, addLayer } = fakeSide();

      await addPickLayer(side, "buurt_klik_2026", "buurt_klik");

      expect(addLayer).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('pickLayer "buurt_klik_2026" not found'),
      );
    });
  });

  // layers.json rethrows on a failed load (it is structural), and losing the
  // pick layer must not take the whole app down with it.
  it("survives a failed config load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" })),
    );
    const { side, addLayer } = fakeSide();

    await expect(addPickLayer(side, "buurt_klik")).resolves.toBeUndefined();
    expect(addLayer).not.toHaveBeenCalled();
  });
});
