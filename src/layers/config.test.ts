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
