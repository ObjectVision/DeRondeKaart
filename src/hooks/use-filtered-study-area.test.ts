import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import type { Feature, Polygon } from "geojson";

import { useFilteredStudyAreaLayers, type FilteredStudyArea } from "@/hooks/use-filtered-study-area";
import type { MapViewHandle } from "@/components/map/map-view-config";

/**
 * The gebiedsfilter's outline is drawn OVER the configured study area, not
 * instead of it.
 *
 * It used to replace it: the studyarea layers were removed and a 200 km grey
 * mask disc drawn in their place. That disc painted `#EBECF0`, the same grey
 * the studyarea's own `outer` rule paints, so now that both are on the map at
 * once it would double up and darken everything outside the study area. These
 * tests pin the two halves of that: the mask is gone, and the outline is dashed
 * so it stays readable where it runs along the border it shares a colour with.
 */

/** Just enough MapLibre Map to record sources and layers. */
function fakeMap() {
  const sources = new Map<string, { data?: unknown }>();
  const layers = new Map<string, { paint?: Record<string, unknown> }>();
  return {
    handle: (() => ({
      map: () => ({
        // styleReady() reads `map.style._loaded` — addSource throws before the
        // style JSON has landed.
        style: { _loaded: true },
        getSource: (id: string) =>
          sources.has(id)
            ? { setData: (d: unknown) => sources.set(id, { data: d }) }
            : undefined,
        addSource: (id: string, spec: { data?: unknown }) => sources.set(id, spec),
        getLayer: (id: string) => layers.get(id),
        addLayer: (spec: { id: string; paint?: Record<string, unknown> }) =>
          layers.set(spec.id, spec),
      }),
    })) as unknown as () => MapViewHandle | null,
    sourceIds: () => [...sources.keys()],
    layerIds: () => [...layers.keys()],
    layer: (id: string) => layers.get(id),
    features: (id: string) =>
      (sources.get(id)?.data as { features?: unknown[] } | undefined)?.features ?? [],
  };
}

const GEBIED: Feature<Polygon> = {
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[5, 51], [6, 51], [6, 52], [5, 51]]] },
  properties: {},
};

const SELECTION: FilteredStudyArea = { area: [GEBIED] };

/**
 * Run the hook with `data` and read what it put on the map.
 *
 * Driven through the returned `resync` rather than by waiting on the effect:
 * both call the same `draw`, and `resync` is synchronous, so the assertions do
 * not hang on Solid's scheduling. It is also the path the basemap-swap
 * re-add uses, so it is worth exercising directly.
 */
function draw(data: FilteredStudyArea | null) {
  const m = fakeMap();
  createRoot((dispose) => {
    useFilteredStudyAreaLayers(() => data, m.handle).resync();
    dispose();
  });
  return m;
}

describe("useFilteredStudyAreaLayers", () => {
  it("draws the gebied outline dashed, in the study-area border colour", () => {
    const paint = draw(SELECTION).layer("filtered-study-area-line")?.paint;

    expect(paint?.["line-color"]).toBe("#00498D");
    expect(paint?.["line-width"]).toBe(2);
    expect(paint?.["line-dasharray"]).toEqual([2, 1.5]);
  });

  /**
   * The regression that matters: the study area now stays drawn, so a second
   * grey mask would darken everything outside it.
   */
  it("draws no mask of its own", () => {
    const m = draw(SELECTION);

    expect(m.sourceIds()).toEqual(["filtered-study-area"]);
    expect(m.layerIds()).toEqual(["filtered-study-area-line"]);
    for (const id of m.layerIds()) {
      expect(m.layer(id)?.paint?.["fill-color"]).toBeUndefined();
    }
  });

  it("feeds the selected geometry into the source", () => {
    expect(draw(SELECTION).features("filtered-study-area")).toHaveLength(1);
  });

  // Clearing the filter must leave nothing behind; the layer stays on the style
  // with an empty feature set, which is how syncGeoJsonOverlay clears.
  it("clears the outline when nothing is selected", () => {
    const m = draw(null);

    expect(m.features("filtered-study-area")).toHaveLength(0);
  });
});
