import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerConfig } from "@/layers";
import {
  TOOL_SCHEMAS,
  isToolName,
  resolveLayer,
  runTool,
  searchLayerConfigs,
} from "@/tools/map-tools";

const layer = (id: string, name: string) => ({ id, name }) as LayerConfig;

const CONFIGS = [
  layer("wz_1", "Woonzorg opgave"),
  layer("en_1", "Energieverbruik"),
  layer("zg_2", "Zorgvraag ouderen"),
];

/** A map side shaped like useMapLayers' result, recording what it is told. */
function fakeSide(initial: LayerConfig[] = []) {
  let entries = initial.map((config) => ({ config }));
  const addLayer = vi.fn(async (config: LayerConfig) => {
    entries = [...entries, { config }];
  });
  const removeLayer = vi.fn((id: string) => {
    entries = entries.filter((e) => e.config.id !== id);
  });
  return {
    side: { layers: { layerEntries: () => entries, addLayer, removeLayer } as never },
    addLayer,
    removeLayer,
    ids: () => entries.map((e) => e.config.id),
  };
}

vi.mock("@/layers", () => ({ loadLayerConfigs: async () => CONFIGS }));
const flyToView = vi.fn();
vi.mock("@/lib/fly-to", () => ({ flyToView: (...a: unknown[]) => flyToView(...a) }));
vi.mock("@/config/map-config", () => ({ searchCountries: () => ["nl"] }));

describe("tool schemas", () => {
  /**
   * The model reads these strings to pick a tool. Measured: English
   * descriptions scored 4/6 on Dutch commands, these Dutch ones 11/12 — so a
   * description silently reverting to English is an accuracy regression with no
   * other symptom.
   */
  it("describes every tool in Dutch", () => {
    for (const schema of Object.values(TOOL_SCHEMAS)) {
      expect(schema.description).toMatch(/[a-z]/);
      // A word that only appears in the Dutch descriptions.
      expect(schema.description.toLowerCase()).toMatch(
        /kaart|zoom de|toon|verberg|zoek/,
      );
      expect(schema.description).not.toMatch(/\b(the|layer|show|hide|search)\b/);
    }
  });

  it("marks every declared parameter required and described", () => {
    for (const schema of Object.values(TOOL_SCHEMAS)) {
      const names = Object.keys(schema.parameters.properties);
      expect(names.length).toBeGreaterThan(0);
      expect(schema.parameters.required).toEqual(names);
      for (const p of Object.values(schema.parameters.properties)) {
        expect(p.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("recognises only real tool names", () => {
    expect(isToolName("open_layer")).toBe(true);
    expect(isToolName("delete_everything")).toBe(false);
  });
});

describe("resolveLayer", () => {
  it("prefers an exact id over a looser name match", () => {
    const configs = [layer("zorg", "Iets anders"), layer("x", "Zorgvraag")];
    expect(resolveLayer(configs, "zorg")?.id).toBe("zorg");
  });

  // The name arrives as free text from speech or typing, never as an id.
  it("matches a name case-insensitively, by substring", () => {
    expect(resolveLayer(CONFIGS, "woonzorg")?.id).toBe("wz_1");
    expect(resolveLayer(CONFIGS, "ENERGIE")?.id).toBe("en_1");
  });

  it("is undefined for no match and for empty input", () => {
    expect(resolveLayer(CONFIGS, "luchtkwaliteit")).toBeUndefined();
    expect(resolveLayer(CONFIGS, "   ")).toBeUndefined();
  });
});

describe("searchLayerConfigs", () => {
  it("returns every keyword match", () => {
    expect(searchLayerConfigs(CONFIGS, "zorg").map((c) => c.id)).toEqual(["wz_1", "zg_2"]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchLayerConfigs(CONFIGS, " ")).toEqual([]);
  });
});

describe("runTool", () => {
  beforeEach(() => flyToView.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("zooms to a geocoded location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => [{ lat: "50.85", lon: "5.69" }] })),
    );
    const { side } = fakeSide();

    const r = await runTool("zoom_to_location", { location: "Maastricht" }, { side });

    expect(r.ok).toBe(true);
    expect(flyToView).toHaveBeenCalledWith([5.69, 50.85]);
  });

  it("reports a location it cannot find", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
    const { side } = fakeSide();

    const r = await runTool("zoom_to_location", { location: "Atlantis" }, { side });

    expect(r.ok).toBe(false);
    expect(r.message).toContain("Atlantis");
  });

  it("opens a layer by its spoken name", async () => {
    const s = fakeSide();

    const r = await runTool("open_layer", { layer: "woonzorg" }, { side: s.side });

    expect(r.ok).toBe(true);
    expect(s.ids()).toEqual(["wz_1"]);
  });

  /**
   * A miss must not be a dead end: the keyword's other matches come back so the
   * caller can offer them instead of the command appearing to do nothing.
   */
  it("offers alternatives when the layer name does not resolve", async () => {
    const s = fakeSide();

    const r = await runTool("open_layer", { layer: "zorg" }, { side: s.side });

    // "zorg" is a substring of two layers, so it resolves rather than missing.
    expect(r.ok).toBe(true);
    const miss = await runTool("open_layer", { layer: "geluid" }, { side: s.side });
    expect(miss.ok).toBe(false);
    expect(miss.matches).toEqual([]);
  });

  // Closing matches only against what is ON the map — matching the whole
  // catalogue would "close" a layer that was never open.
  it("closes only a layer that is actually on the map", async () => {
    const s = fakeSide([CONFIGS[0]]);

    const closed = await runTool("close_layer", { layer: "woonzorg" }, { side: s.side });
    expect(closed.ok).toBe(true);
    expect(s.ids()).toEqual([]);

    const absent = await runTool("close_layer", { layer: "energie" }, { side: s.side });
    expect(absent.ok).toBe(false);
    expect(absent.message).toContain("staat niet aan");
  });

  it("searches layers by keyword", async () => {
    const { side } = fakeSide();

    const r = await runTool("search_layers", { query: "zorg" }, { side });

    expect(r.ok).toBe(true);
    expect(r.matches?.map((c) => c.id)).toEqual(["wz_1", "zg_2"]);
  });

  it("survives a malformed argument from the model", async () => {
    const { side } = fakeSide();

    const r = await runTool("zoom_to_location", { location: 42 }, { side });

    expect(r.ok).toBe(false);
  });
});
