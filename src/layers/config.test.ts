import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLayerConfigs } from "@/layers/config";

/**
 * Round-trips `layers.json` through the real loader.
 *
 * `compareSelectable` was declared on the type and read by the map, but never
 * copied by the validator — so every selection layer loaded as unselectable and
 * silently did nothing. `compare-slots.test.ts` missed it because it builds
 * `LayerConfig` literals and never passes through this path; anything a config
 * file has to carry belongs in a test that starts from JSON.
 */
function stubLayersJson(layers: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      json: async () => ({ layers }),
    })),
  );
}

const BASE = {
  name: "Selectie",
  source: "https://example.test/selectie.pmtiles",
  format: "pmtiles",
  sourceLayer: "gemeente",
  geometryType: "polygon",
  style: { color: [0, 0, 0, 255], opacity: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("layers.json compareSelectable", () => {
  it("survives the loader, and is refused without highlightable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubLayersJson([
      { ...BASE, id: "selectie_ok", highlightable: true, idProperty: "gm_code", compareSelectable: true },
      { ...BASE, id: "selectie_geen_highlight", compareSelectable: true },
      { ...BASE, id: "selectie_onzin", highlightable: true, idProperty: "gm_code", compareSelectable: "ja" },
    ]);

    const configs = await loadLayerConfigs();
    const byId = new Map(configs.map((config) => [config.id, config]));

    expect(byId.get("selectie_ok")?.compareSelectable).toBe(true);
    // Without highlightable there is no promoteId, so a click has no feature id
    // to put in a slot — accepting the flag would produce a dead layer.
    expect(byId.get("selectie_geen_highlight")?.compareSelectable).toBeUndefined();
    expect(byId.get("selectie_onzin")?.compareSelectable).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("selectie_geen_highlight"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("selectie_onzin"));
  });
});

/**
 * Remote GeoJSON: a `source` URL MapLibre fetches itself.
 *
 * The format was refused by the validator until the Nationale Woningbouwkaart
 * layer needed it — its data is two static files on the data host, not tiles.
 * The in-memory variant (`LayerConfig.data`, pushed by the Power BI bridge)
 * never passes through this loader, so a `geojson` entry authored here must
 * carry a source or it would load as an invisible layer.
 */
describe("layers.json geojson format", () => {
  const GEO = {
    name: "Woningbouwplannen",
    source: "https://example.test/punten.geojson",
    format: "geojson",
    geometryType: "point",
    style: {},
  };

  // The loader caches per config name, so every case needs a fresh module
  // registry or the second stub is never read.
  async function loadFresh(layers: unknown[]) {
    vi.resetModules();
    stubLayersJson(layers);
    const { loadLayerConfigs: load } = await import("@/layers/config");
    return load();
  }

  it("accepts a layer whose source is a URL", async () => {
    const configs = await loadFresh([{ ...GEO, id: "woningbouw" }]);

    const layer = configs.find((c) => c.id === "woningbouw");
    expect(layer?.format).toBe("geojson");
    expect(layer?.source).toBe("https://example.test/punten.geojson");
  });

  it("drops one with no source at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configs = await loadFresh([{ ...GEO, id: "bronloos", source: "" }]);

    expect(configs.find((c) => c.id === "bronloos")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bronloos"));
  });

  it("accepts geojson as a composite child", async () => {
    const configs = await loadFresh([
      {
        id: "samengesteld",
        name: "Samengesteld",
        format: "composite",
        source: "",
        style: {},
        layers: [
          { source: "https://example.test/vlakken.geojson", format: "geojson",
            geometryType: "polygon", style: {}, minzoom: 11 },
          { source: "https://example.test/punten.geojson", format: "geojson",
            geometryType: "point", style: {} },
        ],
      },
    ]);

    const parent = configs.find((c) => c.id === "samengesteld");
    expect(parent?.layers).toHaveLength(2);
    expect(parent?.layers?.map((c) => c.format)).toEqual(["geojson", "geojson"]);
    // Child zoom bands must survive: the areas only show from zoom 11.
    expect(parent?.layers?.[0].minzoom).toBe(11);
  });
});
