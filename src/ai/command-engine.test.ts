import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayerConfig } from "@/layers";
import { runCommand, type Parser } from "@/ai/command-engine";

const CONFIGS = [{ id: "wz_1", name: "Woonzorg opgave" }] as LayerConfig[];

vi.mock("@/layers", () => ({ loadLayerConfigs: async () => CONFIGS }));

const flyToView = vi.fn();
vi.mock("@/lib/fly-to", () => ({ flyToView: (...a: unknown[]) => flyToView(...a) }));

let allowed: string[] = ["zoom_to_location", "open_layer", "close_layer", "search_layers"];
// `searchProvider` decides which backend the geocoder builds a URL for, so the
// location-search fallback needs it stubbed alongside `searchCountries`.
vi.mock("@/config/map-config", () => ({
  searchCountries: () => ["nl"],
  searchProvider: () => "nominatim",
  enabledTools: () => allowed,
}));

function fakeSide(initial: LayerConfig[] = []) {
  let entries = initial.map((config) => ({ config }));
  return {
    ctx: {
      side: {
        layers: {
          layerEntries: () => entries,
          addLayer: async (c: LayerConfig) => {
            entries = [...entries, { config: c }];
          },
          removeLayer: (id: string) => {
            entries = entries.filter((e) => e.config.id !== id);
          },
        } as never,
      },
    },
    ids: () => entries.map((e) => e.config.id),
  };
}

const parserReturning = (calls: Parameters<Parser["parse"]> extends never ? never : unknown[]) =>
  ({ parse: async () => calls as never }) as Parser;

/** Nominatim answering with one hit. */
function stubGeocoder() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [{ lat: "50.85", lon: "5.69" }] })),
  );
}

describe("runCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    flyToView.mockClear();
    allowed = ["zoom_to_location", "open_layer", "close_layer", "search_layers"];
  });

  /**
   * The load-bearing fallback: while the model is still downloading there is no
   * parser, and the bar must behave exactly as it always has.
   */
  it("searches for a location when no parser is ready", async () => {
    stubGeocoder();
    const s = fakeSide();

    const r = await runCommand("Maastricht", s.ctx, null);

    expect(r.ok).toBe(true);
    expect(flyToView).toHaveBeenCalled();
  });

  it("runs a single parsed call", async () => {
    const s = fakeSide();

    const r = await runCommand(
      "toon de laag woonzorg",
      s.ctx,
      parserReturning([{ name: "open_layer", arguments: { layer: "woonzorg" } }]),
    );

    expect(r.ok).toBe(true);
    expect(s.ids()).toEqual(["wz_1"]);
  });

  // An over-eager refusal must not be a dead end.
  it("falls back to a location search when the model refuses", async () => {
    stubGeocoder();
    const s = fakeSide();

    const r = await runCommand("Venlo", s.ctx, parserReturning([]));

    expect(r.ok).toBe(true);
    expect(flyToView).toHaveBeenCalled();
  });

  it("falls back when the parser throws", async () => {
    stubGeocoder();
    const s = fakeSide();
    const broken: Parser = {
      parse: async () => {
        throw new Error("wasm exploded");
      },
    };

    const r = await runCommand("Roermond", s.ctx, broken);

    expect(r.ok).toBe(true);
    expect(flyToView).toHaveBeenCalled();
  });

  it("runs only the first of several calls", async () => {
    const s = fakeSide();

    await runCommand(
      "toon woonzorg en verberg woonzorg",
      s.ctx,
      parserReturning([
        { name: "open_layer", arguments: { layer: "woonzorg" } },
        { name: "close_layer", arguments: { layer: "woonzorg" } },
      ]),
    );

    // The close did not also run, so the layer is still on.
    expect(s.ids()).toEqual(["wz_1"]);
  });

  /**
   * A project can narrow the tool list. A call to a tool it did not enable must
   * not run just because the model produced it.
   */
  it("ignores a call to a tool this project has not enabled", async () => {
    stubGeocoder();
    allowed = ["zoom_to_location"];
    const s = fakeSide();

    const r = await runCommand(
      "toon de laag woonzorg",
      s.ctx,
      parserReturning([{ name: "open_layer", arguments: { layer: "woonzorg" } }]),
    );

    expect(s.ids()).toEqual([]);
    // It degraded to a location search rather than doing nothing.
    expect(r.ok).toBe(true);
    expect(flyToView).toHaveBeenCalled();
  });

  it("ignores a call to a tool that does not exist", async () => {
    stubGeocoder();
    const s = fakeSide();

    await runCommand(
      "doe iets vreemds",
      s.ctx,
      parserReturning([{ name: "drop_database", arguments: {} }]),
    );

    expect(flyToView).toHaveBeenCalled();
  });

  it("does nothing for empty input", async () => {
    const s = fakeSide();
    const r = await runCommand("   ", s.ctx, null);
    expect(r.ok).toBe(false);
    expect(flyToView).not.toHaveBeenCalled();
  });
});
