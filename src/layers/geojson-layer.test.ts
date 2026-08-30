import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";

import { addGeoJsonLayer } from "@/layers/geojson-layer";
import type { LayerConfig } from "@/layers/types";

/**
 * The geojson source takes its features from one of two places, and which one
 * decides whether anything renders at all.
 *
 * `data` is in-memory features from the Power BI host; `source` is a URL
 * MapLibre fetches itself. The URL form was unreachable until the Nationale
 * Woningbouwkaart needed it — the loader read `data` only, so a config with a
 * perfectly good URL produced an empty layer and no error.
 */

/**
 * Just enough MapLibre Map to record what the loader asks for.
 *
 * `getSource` returns the live source object (carrying `setData`), NOT the spec
 * it was added with — that is how MapLibre behaves, and modelling it the other
 * way sends the loader down its update branch on a first add.
 */
function fakeMap() {
  const specs = new Map<string, { data?: unknown }>();
  const layers = new Map<string, unknown>();
  const addSource = vi.fn((id: string, spec: { data?: unknown }) => specs.set(id, spec));
  const setData = vi.fn((id: string, d: unknown) => {
    const spec = specs.get(id);
    if (spec) spec.data = d;
  });
  return {
    map: {
      // styleReady() reads `map.style._loaded` — addSource throws before the
      // style JSON has landed, and that internal flag is what it checks.
      style: { _loaded: true },
      getStyle: () => ({ layers: [] }),
      addSource,
      getSource: (id: string) =>
        specs.has(id) ? { setData: (d: unknown) => setData(id, d) } : undefined,
      addLayer: vi.fn((spec: { id: string }) => layers.set(spec.id, spec)),
      getLayer: (id: string) => layers.get(id),
      hasImage: () => true,
      addImage: vi.fn(),
    },
    addSource,
    /** The `data` the source currently holds, however it got there. */
    sourceData: () => specs.get("geojson-source-test")?.data,
  };
}

const FEATURES: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [5.87, 51.76] },
      properties: { Plannaam: "Lindelaan 63A" },
    },
  ],
};

const BASE = {
  id: "test",
  name: "Woningbouwplannen",
  format: "geojson",
  geometryType: "point",
  style: {},
} as const;

function config(extra: Partial<LayerConfig>): LayerConfig {
  return { ...BASE, source: "", ...extra } as LayerConfig;
}

describe("addGeoJsonLayer", () => {
  it("hands MapLibre the URL when only a source is set", () => {
    const m = fakeMap();

    addGeoJsonLayer(
      config({ source: "https://example.test/punten.geojson" }),
      () => m.map as never,
    );

    expect(m.sourceData()).toBe("https://example.test/punten.geojson");
  });

  it("hands MapLibre the features when data is set", () => {
    const m = fakeMap();

    addGeoJsonLayer(config({ data: FEATURES }), () => m.map as never);

    expect(m.sourceData()).toBe(FEATURES);
  });

  /**
   * The host's features are the more specific answer: a bridge-pushed dataset
   * must not be replaced by whatever a leftover `source` points at.
   */
  it("prefers in-memory data over a source URL", () => {
    const m = fakeMap();

    addGeoJsonLayer(
      config({ source: "https://example.test/punten.geojson", data: FEATURES }),
      () => m.map as never,
    );

    expect(m.sourceData()).toBe(FEATURES);
  });

  it("adds nothing when there is neither", () => {
    const m = fakeMap();

    addGeoJsonLayer(config({}), () => m.map as never);

    expect(m.addSource).not.toHaveBeenCalled();
  });
});
