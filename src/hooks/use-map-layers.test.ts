import { describe, expect, it } from "vitest";
import { createEffect, createRoot } from "solid-js";

import { useMapLayers, type UseMapLayersResult } from "@/hooks/use-map-layers";
import type { MapAccessor } from "@/components/map/map-view-config";
import type { LayerConfig } from "@/layers";

/**
 * `useMapLayers` carried six ref mirrors under React, purely so the composite
 * host (driven by a MapLibre `moveend` listener, outside React) could read the
 * current stack synchronously. These tests pin the two properties that let all
 * six be deleted: a write is visible to the very next synchronous read, and
 * observers re-run without being told.
 *
 * The map accessor yields null throughout — the native add/remove helpers no-op
 * without a map, which is the same path the export preview takes before its
 * MapLibre instance exists.
 */
const noMap: MapAccessor = () => null;

/**
 * A map whose object exists but whose style has not arrived — the state a
 * freshly mounted MapView is in for one synchronous tick. Every mutator throws,
 * exactly as MapLibre does ("Style is not done loading").
 */
function unloadedMap() {
  const throwUnloaded = () => {
    throw new Error("Style is not done loading");
  };
  return {
    style: { _loaded: false },
    getSource: () => undefined,
    getLayer: () => undefined,
    addSource: throwUnloaded,
    addLayer: throwUnloaded,
    removeLayer: throwUnloaded,
    removeSource: throwUnloaded,
    moveLayer: throwUnloaded,
    setPaintProperty: throwUnloaded,
    setLayoutProperty: throwUnloaded,
    setFilter: throwUnloaded,
  } as unknown as NonNullable<ReturnType<MapAccessor>>;
}

function config(id: string, over: Partial<LayerConfig> = {}): LayerConfig {
  return {
    id,
    name: id,
    source: `https://example.invalid/${id}.pmtiles`,
    format: "pmtiles",
    sourceLayer: id,
    style: { color: "#000000" },
    ...over,
  } as LayerConfig;
}

/**
 * Run `body` inside a reactive root and dispose it afterwards. The stack binds
 * its map at construction, so the fake goes in here rather than at every call.
 */
async function withLayers(
  body: (layers: UseMapLayersResult) => Promise<void>,
  getMap: MapAccessor = noMap,
) {
  let dispose = () => {};
  const layers = createRoot((d) => {
    dispose = d;
    return useMapLayers(getMap);
  });
  try {
    await body(layers);
  } finally {
    dispose();
  }
}

describe("useMapLayers", () => {
  it("commits an entry before awaiting the data load", async () => {
    await withLayers(async (layers) => {
      const pending = layers.addLayer(config("a"));
      // Not awaited yet: the entry is already there. This is what lets the
      // export preview's reconcile loop use layerEntries() as its own
      // "already added?" check within one synchronous pass.
      expect(layers.layerEntries().map((e) => e.config.id)).toEqual(["a"]);
      await pending;
      expect(layers.layerEntries()).toHaveLength(1);
    });
  });

  it("is idempotent for an id already present", async () => {
    await withLayers(async (layers) => {
      await layers.addLayer(config("a"));
      await layers.addLayer(config("a"));
      expect(layers.layerEntries()).toHaveLength(1);
    });
  });

  it("re-runs an observer on every stack change, with no mirror to update", async () => {
    await withLayers(async (layers) => {
      const seen: string[][] = [];
      createEffect(() => seen.push(layers.layerEntries().map((e) => e.config.id)));

      await layers.addLayer(config("a"));
      await layers.addLayer(config("b"));
      layers.removeLayer("a");

      // Solid batches effects, so assert the settled value rather than each step.
      await Promise.resolve();
      expect(layers.layerEntries().map((e) => e.config.id)).toEqual(["b"]);
      expect(seen.length).toBeGreaterThan(0);
    });
  });

  it("toggles visibility and reports it on the next synchronous read", async () => {
    await withLayers(async (layers) => {
      await layers.addLayer(config("a"));
      expect(layers.hiddenIds().has("a")).toBe(false);

      layers.toggleLayer("a");
      // No await: the signal write landed, which is exactly what removed the
      // "run the map side effect inside the state updater" workaround.
      expect(layers.hiddenIds().has("a")).toBe(true);

      layers.toggleLayer("a");
      expect(layers.hiddenIds().has("a")).toBe(false);
    });
  });

  it("clears a removed layer's hidden, rule and timeseries state", async () => {
    await withLayers(async (layers) => {
      await layers.addLayer(config("a"));
      layers.hideLayer("a");
      layers.toggleDim("a");
      expect(layers.hiddenIds().has("a")).toBe(true);
      expect(layers.dimmedIds().has("a")).toBe(true);

      layers.removeLayer("a");
      expect(layers.layerEntries()).toHaveLength(0);
      expect(layers.hiddenIds().has("a")).toBe(false);
      expect(layers.hiddenRules().has("a")).toBe(false);
      // `dimmedIds` is deliberately NOT cleared — pinning the asymmetry so a
      // future change to removeLayer has to be a decision, not a slip. Re-adding
      // the layer therefore brings it back dimmed.
      expect(layers.dimmedIds().has("a")).toBe(true);
    });
  });

  it("keeps the entry when the map has mounted but its style has not", async () => {
    // Regression: moving a layer to the right map mounts that MapView
    // synchronously, so the accessor yields a live-but-unloaded map. Without a
    // styleReady guard addSource throws, addLayer rolls the entry back, and the
    // right map unmounts again — the layer just disappears.
    await withLayers(
      async (layers) => {
        await layers.addLayer(config("a"));
        expect(layers.layerEntries().map((e) => e.config.id)).toEqual(["a"]);
      },
      () => unloadedMap(),
    );
  });

  it("appends verbatim with atEnd, preserving a caller's ordering", async () => {
    await withLayers(async (layers) => {
      await layers.addLayer(config("bottom"), { atEnd: true });
      await layers.addLayer(config("top"), { atEnd: true });
      expect(layers.layerEntries().map((e) => e.config.id)).toEqual(["bottom", "top"]);
    });
  });

  it("keeps two instances independent, as the two map panes require", async () => {
    await withLayers(async (left) => {
      await withLayers(async (right) => {
        await left.addLayer(config("a"));
        expect(left.layerEntries()).toHaveLength(1);
        expect(right.layerEntries()).toHaveLength(0);
      });
    });
  });
});
