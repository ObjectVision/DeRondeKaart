import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TOOLS,
  complementaryDashboardEnabled,
  loadMapConfig,
  standaloneDashboardEnabled,
} from "@/config/map-config";
import { TOOL_NAMES } from "@/tools/tool-names";

/**
 * `loadMapConfig` fetches `/map.json` and writes module-level caches for the
 * icon accessors. Each test stubs fetch with its own body; nothing here reads
 * those caches, so the writes are harmless.
 */
function stubMapJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("map.json dashboard capability", () => {
  it("defaults to off when the key is absent", async () => {
    stubMapJson({ center: [5, 52], zoom: 7 });
    const config = await loadMapConfig();
    expect(config.dashboard).toBe("off");
  });

  it.each(["off", "standalone", "complementary", "both"] as const)(
    "accepts %s",
    async (value) => {
      stubMapJson({ dashboard: value });
      const config = await loadMapConfig();
      expect(config.dashboard).toBe(value);
    },
  );

  it("warns and falls back to off on an unknown value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({ dashboard: "dashboards-please" });
    const config = await loadMapConfig();
    expect(config.dashboard).toBe("off");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid "dashboard"'));
  });

  it("maps each mode to the two entry points", () => {
    expect(standaloneDashboardEnabled("off")).toBe(false);
    expect(standaloneDashboardEnabled("standalone")).toBe(true);
    expect(standaloneDashboardEnabled("complementary")).toBe(false);
    expect(standaloneDashboardEnabled("both")).toBe(true);

    expect(complementaryDashboardEnabled("off")).toBe(false);
    expect(complementaryDashboardEnabled("standalone")).toBe(false);
    expect(complementaryDashboardEnabled("complementary")).toBe(true);
    expect(complementaryDashboardEnabled("both")).toBe(true);
  });
});

describe('map.json variants', () => {
  it("is undefined when the key is absent, leaving the project single-dataset", async () => {
    stubMapJson({ center: [5, 52], zoom: 7 });
    const config = await loadMapConfig();
    expect(config.variants).toBeUndefined();
  });

  it("accepts a well-formed block and defaults to the declared default", async () => {
    stubMapJson({
      variants: {
        default: "2026",
        items: [
          { id: "2025", label: "Startanalyse 2025" },
          { id: "2026", label: "Startanalyse 2026" },
        ],
      },
    });
    const config = await loadMapConfig();
    expect(config.variants?.default).toBe("2026");
    expect(config.variants?.items.map((i) => i.id)).toEqual(["2025", "2026"]);
  });

  it("falls back to the first item when default names an unknown id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({
      variants: { default: "1999", items: [{ id: "2025", label: "A" }] },
    });
    const config = await loadMapConfig();
    expect(config.variants?.default).toBe("2025");
  });

  it("labels a variant by its id when no label is given", async () => {
    stubMapJson({ variants: { items: [{ id: "2025" }] } });
    const config = await loadMapConfig();
    expect(config.variants?.items[0].label).toBe("2025");
  });

  // Ids become URL path segments, so a traversal attempt must not survive
  // validation and reach configPath().
  it.each([" ", "..", "../secret", "a/b", ""])(
    "rejects the unsafe id %j",
    async (id) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubMapJson({ variants: { items: [{ id, label: "x" }] } });
      const config = await loadMapConfig();
      expect(config.variants).toBeUndefined();
    },
  );

  it("drops a duplicate id rather than shadowing the first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({
      variants: {
        items: [
          { id: "2025", label: "First" },
          { id: "2025", label: "Second" },
        ],
      },
    });
    const config = await loadMapConfig();
    expect(config.variants?.items).toHaveLength(1);
    expect(config.variants?.items[0].label).toBe("First");
  });

  it.each([null, 42, "2026", [], { items: "no" }, { items: [] }])(
    "ignores the malformed block %j",
    async (variants) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubMapJson({ variants });
      const config = await loadMapConfig();
      expect(config.variants).toBeUndefined();
    },
  );
});

/**
 * `mapControls.searchCountries` limits the location search to given countries.
 *
 * Validated rather than passed through because Nominatim answers an unknown
 * code with an empty result set: a typo like "NLD" would return nothing on
 * every search and read as a broken search box, with nothing to explain it.
 */
describe("map.json mapControls.searchCountries", () => {
  it("is empty when the key is absent, searching the whole world", async () => {
    stubMapJson({ mapControls: { search: true, zoom: false } });
    const config = await loadMapConfig();
    expect(config.mapControls.searchCountries).toEqual([]);
  });

  it("keeps the configured codes", async () => {
    stubMapJson({ mapControls: { searchCountries: ["nl"] } });
    const config = await loadMapConfig();
    expect(config.mapControls.searchCountries).toEqual(["nl"]);
  });

  it("normalises case and surrounding space", async () => {
    stubMapJson({ mapControls: { searchCountries: ["NL", " De "] } });
    const config = await loadMapConfig();
    expect(config.mapControls.searchCountries).toEqual(["nl", "de"]);
  });

  it("drops duplicates", async () => {
    stubMapJson({ mapControls: { searchCountries: ["nl", "NL"] } });
    const config = await loadMapConfig();
    expect(config.mapControls.searchCountries).toEqual(["nl"]);
  });

  it("drops malformed codes and keeps the good ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({ mapControls: { searchCountries: ["nl", "NLD", "Netherlands", 42] } });
    const config = await loadMapConfig();
    expect(config.mapControls.searchCountries).toEqual(["nl"]);
    expect(warn).toHaveBeenCalled();
  });

  it.each([null, 42, "nl", { nl: true }])(
    "ignores the non-array value %j",
    async (searchCountries) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubMapJson({ mapControls: { searchCountries } });
      const config = await loadMapConfig();
      expect(config.mapControls.searchCountries).toEqual([]);
    },
  );
});

/**
 * The five-tool ceiling.
 *
 * Measured against the real model: with six tools `needle_init` returns 1 and
 * the command bar silently answers nothing ever again, falling back to a
 * location search with no error anywhere. A config is the one place that number
 * can be exceeded, so it is the place to clamp it.
 */
describe("map.json tools", () => {
  it("defaults to every tool", async () => {
    stubMapJson({});
    const config = await loadMapConfig();
    expect(config.tools).toEqual([...TOOL_NAMES]);
  });

  it("keeps a configured subset", async () => {
    stubMapJson({ tools: ["open_layer", "close_layer"] });
    const config = await loadMapConfig();
    expect(config.tools).toEqual(["open_layer", "close_layer"]);
  });

  it("drops unknown names with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({ tools: ["open_layer", "delete_everything"] });
    const config = await loadMapConfig();
    expect(config.tools).toEqual(["open_layer"]);
    expect(warn).toHaveBeenCalled();
  });

  it("drops duplicates", async () => {
    stubMapJson({ tools: ["open_layer", "open_layer"] });
    const config = await loadMapConfig();
    expect(config.tools).toEqual(["open_layer"]);
  });

  /**
   * The whole catalogue must stay shippable: the day a fifth and sixth tool are
   * added, `tools: undefined` would hand the model more than it accepts.
   */
  it("never lets the default exceed what the model accepts", () => {
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it("leaves a full, legitimate set alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({ tools: [...TOOL_NAMES] });
    const config = await loadMapConfig();

    expect(config.tools).toEqual([...TOOL_NAMES]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The clamp itself, against `validateTools` rather than `loadMapConfig`.
 *
 * Four tool names exist, so no `map.json` can carry six valid ones and the cap
 * is unreachable through the config path — a test written there passes whether
 * the clamp is present or deleted. Driving the validator directly, with the
 * name list stubbed to a longer one, is what actually exercises it.
 */
describe("the tool ceiling", () => {
  it("keeps the default catalogue within the model's limit", () => {
    expect(TOOL_NAMES.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it("clamps an over-long list and says what it dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Six distinct names, as a future catalogue would have.
    const many = [
      "zoom_to_location",
      "open_layer",
      "close_layer",
      "search_layers",
      "set_basemap",
      "download_data",
    ];
    vi.doMock("@/tools/tool-names", () => ({
      TOOL_NAMES: many,
      isToolName: (v: string) => many.includes(v),
    }));
    vi.resetModules();
    const { validateTools, MAX_TOOLS: cap } = await import("@/config/map-config");

    const kept = validateTools(many);

    expect(kept).toHaveLength(cap);
    expect(kept).toEqual(many.slice(0, cap));
    // The surplus must be named, or a config author has no way to know which
    // tools stopped working.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("download_data"));
    vi.doUnmock("@/tools/tool-names");
    vi.resetModules();
  });
});
