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

describe("layers.json meta", () => {
  // The loader caches per config name, so every case needs a fresh module
  // registry or the second stub is never read.
  async function loadFresh(layers: unknown[]) {
    vi.resetModules();
    stubLayersJson(layers);
    const { loadLayerConfigs: load } = await import("@/layers/config");
    return load();
  }

  /**
   * The object form is what gives the metainfo dialog its tabs. It has to reach
   * LayerConfig intact: a validator that dropped it would leave the dialog
   * reporting "Geen informatie beschikbaar" for a correctly configured layer,
   * with nothing but a console warning to say why.
   */
  it("keeps the three routes, each as a path or a list of them", async () => {
    const configs = await loadFresh([
      {
        ...BASE,
        id: "drie_tabs",
        meta: {
          toelichting: "/data/meta/x_toelichting.html",
          bronnen: ["/data/meta/x_bronnen.html", "/data/meta/gedeeld.html"],
          aannames_en_onzekerheden: "/data/meta/x_aannames_en_onzekerheden.html",
        },
      },
    ]);

    expect(configs[0].meta).toEqual({
      toelichting: "/data/meta/x_toelichting.html",
      bronnen: ["/data/meta/x_bronnen.html", "/data/meta/gedeeld.html"],
      aannames_en_onzekerheden: "/data/meta/x_aannames_en_onzekerheden.html",
    });
  });

  // A layer whose spreadsheet cell is empty gets no file for that route, so its
  // key is simply absent. That is the ordinary case, not an error.
  it("accepts an object naming only some of the routes", async () => {
    const configs = await loadFresh([
      { ...BASE, id: "twee_tabs", meta: { toelichting: "/a.html", bronnen: "/b.html" } },
    ]);

    expect(configs[0].meta).toEqual({ toelichting: "/a.html", bronnen: "/b.html" });
  });

  /**
   * A malformed route must not take the whole layer's metainfo with it: the
   * other tabs still have documents to show, and dropping them would turn one
   * bad path into a blank dialog.
   */
  it("drops an unusable route but keeps the rest, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configs = await loadFresh([
      { ...BASE, id: "half", meta: { toelichting: "/a.html", bronnen: 42, aannames_en_onzekerheden: [] } },
    ]);

    expect(configs[0].meta).toEqual({ toelichting: "/a.html" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"meta.bronnen"'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"meta.aannames_en_onzekerheden"'),
    );
  });

  // Nothing usable left is the same outcome as any other invalid value —
  // warned about rather than left as an object the dialog would render empty.
  it("ignores an object with no usable route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configs = await loadFresh([
      { ...BASE, id: "leeg", meta: { toelichting: "", onbekend: "/x.html" } },
    ]);

    expect(configs[0].meta).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("leeg"));
  });

  /**
   * startanalyse2026 spells every one of its ~600 `meta` values as an array, and
   * woningbouwkaart.html as a plain string. Both must survive the object form
   * being added, or adding tabs would silently blank the metainfo of another
   * project entirely.
   */
  it("leaves the string and array forms exactly as they were", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const configs = await loadFresh([
      { ...BASE, id: "een_string", meta: "/data/meta/woningbouwkaart.html" },
      { ...BASE, id: "een_lijst", meta: ["LN_default.html", "_footer.html"] },
      { ...BASE, id: "rommel_in_lijst", meta: ["goed.html", 7, ""] },
      { ...BASE, id: "onzin", meta: 3 },
    ]);
    const byId = new Map(configs.map((config) => [config.id, config]));

    expect(byId.get("een_string")?.meta).toBe("/data/meta/woningbouwkaart.html");
    expect(byId.get("een_lijst")?.meta).toEqual(["LN_default.html", "_footer.html"]);
    // One bad entry drops, the rest still compose.
    expect(byId.get("rommel_in_lijst")?.meta).toEqual(["goed.html"]);
    expect(byId.get("onzin")?.meta).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("onzin"));
  });
});
