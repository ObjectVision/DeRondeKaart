import { afterEach, describe, expect, it, vi } from "vitest";

import {
  complementaryDashboardEnabled,
  loadMapConfig,
  standaloneDashboardEnabled,
} from "@/config/map-config";

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
