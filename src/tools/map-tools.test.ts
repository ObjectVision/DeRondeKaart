import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerConfig } from "@/layers";
import {
  TOOL_SCHEMAS,
  isToolName,
  resolveLayer,
  resolveSide,
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

  it("describes every declared parameter", () => {
    for (const schema of Object.values(TOOL_SCHEMAS)) {
      const names = Object.keys(schema.parameters.properties);
      expect(names.length).toBeGreaterThan(0);
      // Everything required must actually be declared.
      expect(names).toEqual(expect.arrayContaining(schema.parameters.required));
      for (const p of Object.values(schema.parameters.properties)) {
        expect(p.description.length).toBeGreaterThan(0);
      }
    }
  });

  /**
   * `kaart` must stay OPTIONAL. Required, the model invents a side for every
   * command; optional, it supplies one only when the user names it and every
   * other command keeps meaning the left map.
   */
  it("keeps the map side optional on the layer tools", () => {
    for (const name of ["open_layer", "close_layer"] as const) {
      expect(TOOL_SCHEMAS[name].parameters.properties.kaart).toBeTruthy();
      expect(TOOL_SCHEMAS[name].parameters.required).not.toContain("kaart");
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

  /**
   * Comparison mode is derived — it turns on when the right map holds a layer —
   * so addressing the right map is the only way a command can reach it.
   */
  describe("map side", () => {
    /** Left with a layer on it, so the left-anchored guard is satisfied. */
    const both = () => {
      const left = fakeSide([CONFIGS[1]]);
      const right = fakeSide();
      return {
        left,
        right,
        ctx: { side: left.side, right: right.side, leftHasLayers: () => true },
      };
    };

    it("opens on the right map when the command says so", async () => {
      const { left, right, ctx } = both();

      const r = await runTool("open_layer", { layer: "woonzorg", kaart: "rechterkaart" }, ctx);

      expect(r.ok).toBe(true);
      expect(right.ids()).toEqual(["wz_1"]);
      expect(left.ids()).toEqual(["en_1"]);
    });

    it("opens on the left map when no side is named", async () => {
      const { left, right, ctx } = both();

      await runTool("open_layer", { layer: "woonzorg" }, ctx);

      expect(left.ids()).toEqual(["en_1", "wz_1"]);
      expect(right.ids()).toEqual([]);
    });

    // The model echoes the user's own words, so one meaning arrives spelled
    // several ways.
    it("understands the ways a user says 'right'", () => {
      for (const spoken of ["rechts", "rechterkaart", "de rechter kaart", "op rechts"]) {
        expect(resolveSide(spoken)).toBe("right");
      }
    });

    // A garbled side must never send a layer somewhere unasked.
    it("falls back to the left map for anything unrecognised", () => {
      for (const spoken of ["links", "midden", "", 42, undefined, null]) {
        expect(resolveSide(spoken)).toBe("left");
      }
    });

    it("refuses the right map while the left one is empty", async () => {
      const left = fakeSide();
      const right = fakeSide();

      const r = await runTool(
        "open_layer",
        { layer: "woonzorg", kaart: "rechts" },
        { side: left.side, right: right.side, leftHasLayers: () => false },
      );

      expect(r.ok).toBe(false);
      expect(r.message).toContain("linkerkaart");
      expect(right.ids()).toEqual([]);
    });

    it("refuses the right map when the project has none", async () => {
      const left = fakeSide([CONFIGS[1]]);

      const r = await runTool(
        "open_layer",
        { layer: "woonzorg", kaart: "rechts" },
        { side: left.side },
      );

      expect(r.ok).toBe(false);
      expect(left.ids()).toEqual(["en_1"]);
    });

    it("closes on the right map when the command says so", async () => {
      const left = fakeSide([CONFIGS[1]]);
      const right = fakeSide([CONFIGS[0]]);

      const r = await runTool(
        "close_layer",
        { layer: "woonzorg", kaart: "rechts" },
        { side: left.side, right: right.side },
      );

      expect(r.ok).toBe(true);
      expect(right.ids()).toEqual([]);
    });
  });

  /**
   * A paired layer spans both maps and its halves must come off together. The
   * legend's close button routes through `removeFromSide` for exactly this
   * reason; closing by voice has to reach the same path, or it strands the
   * partner on the other map.
   */
  describe("pair-aware close", () => {
    it("routes through the injected closer instead of removing directly", async () => {
      const s = fakeSide([CONFIGS[0]]);
      const removeLayer = vi.fn();

      const r = await runTool(
        "close_layer",
        { layer: "woonzorg" },
        { side: s.side, removeLayer },
      );

      expect(r.ok).toBe(true);
      expect(removeLayer).toHaveBeenCalledWith("wz_1", "left");
      // The side's own remove must NOT be called: it is the pair-blind path.
      expect(s.removeLayer).not.toHaveBeenCalled();
    });

    it("tells the closer which map the layer was on", async () => {
      const left = fakeSide([CONFIGS[1]]);
      const right = fakeSide([CONFIGS[0]]);
      const removeLayer = vi.fn();

      await runTool(
        "close_layer",
        { layer: "woonzorg", kaart: "rechts" },
        { side: left.side, right: right.side, removeLayer },
      );

      expect(removeLayer).toHaveBeenCalledWith("wz_1", "right");
    });

    // The tool layer stays usable on its own, which is what keeps these tests
    // free of App wiring.
    it("removes directly when no closer is injected", async () => {
      const s = fakeSide([CONFIGS[0]]);

      await runTool("close_layer", { layer: "woonzorg" }, { side: s.side });

      expect(s.removeLayer).toHaveBeenCalledWith("wz_1");
    });
  });
});
