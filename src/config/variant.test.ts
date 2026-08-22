import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  configPath,
  initVariants,
  isVariantId,
  setVariant,
  variantCacheKey,
  variantId,
  variantsConfig,
} from "./variant";
import type { VariantsConfig } from "./map-config";

const TWO: VariantsConfig = {
  default: "2025",
  items: [
    { id: "2025", label: "Startanalyse 2025" },
    { id: "2026", label: "Startanalyse 2026" },
  ],
};

/** Point window.location.search at `query` for the duration of one test. */
function withSearch(query: string) {
  window.history.replaceState({}, "", query ? `/?${query}` : "/");
}

describe("config variants", () => {
  beforeEach(() => {
    withSearch("");
    initVariants(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("a project with no variants", () => {
    it("has no active variant", () => {
      expect(variantId()).toBeNull();
      expect(variantsConfig()).toBeNull();
    });

    // The regression guard for every existing project: their config fetches
    // must stay at the site root, byte-identical to before this feature.
    it("resolves config paths at the site root", () => {
      expect(configPath("layers.json")).toBe("/layers.json");
      expect(configPath("navigation.json")).toBe("/navigation.json");
      expect(configPath("map.json")).toBe("/map.json");
    });

    it("shares one cache key across every file", () => {
      expect(variantCacheKey("layers.json")).toBe("");
      expect(variantCacheKey("map.json")).toBe("");
    });

    it("refuses to switch", () => {
      expect(setVariant("2026")).toBe(false);
      expect(variantId()).toBeNull();
    });
  });

  describe("initial selection", () => {
    it("uses variants.default when the URL names none", () => {
      initVariants(TWO);
      expect(variantId()).toBe("2025");
    });

    it("uses the URL parameter when it names a declared variant", () => {
      withSearch("variant=2026");
      initVariants(TWO);
      expect(variantId()).toBe("2026");
    });

    it("falls back to the default for an unknown URL variant", () => {
      withSearch("variant=1999");
      initVariants(TWO);
      expect(variantId()).toBe("2025");
      expect(console.warn).toHaveBeenCalled();
    });

    it("falls back to the first item when no default is declared", () => {
      initVariants({ items: TWO.items });
      expect(variantId()).toBe("2025");
    });

    it("treats an empty items list as no variants at all", () => {
      initVariants({ items: [] });
      expect(variantId()).toBeNull();
    });
  });

  describe("with variants active", () => {
    beforeEach(() => initVariants(TWO));

    it("prefixes only the per-variant files", () => {
      expect(configPath("layers.json")).toBe("/2025/layers.json");
      expect(configPath("navigation.json")).toBe("/2025/navigation.json");
      // Shared across variants — must stay at the root or every project's
      // map.json/filter.json/charts.json would 404 under a variant.
      expect(configPath("map.json")).toBe("/map.json");
      expect(configPath("filter.json")).toBe("/filter.json");
      expect(configPath("charts.json")).toBe("/charts.json");
    });

    it("re-resolves paths after a switch", () => {
      expect(setVariant("2026")).toBe(true);
      expect(variantId()).toBe("2026");
      expect(configPath("layers.json")).toBe("/2026/layers.json");
      expect(configPath("map.json")).toBe("/map.json");
    });

    it("keys per-variant files by variant and shared files by nothing", () => {
      expect(variantCacheKey("layers.json")).toBe("2025");
      expect(variantCacheKey("map.json")).toBe("");
      setVariant("2026");
      expect(variantCacheKey("layers.json")).toBe("2026");
      expect(variantCacheKey("map.json")).toBe("");
    });

    it("rejects an unknown id without changing the active variant", () => {
      expect(setVariant("1999")).toBe(false);
      expect(variantId()).toBe("2025");
      expect(console.warn).toHaveBeenCalled();
    });

    it("reports no-change when asked for the variant already active", () => {
      expect(setVariant("2025")).toBe(false);
      expect(variantId()).toBe("2025");
    });

    it("recognises declared ids", () => {
      expect(isVariantId("2025")).toBe(true);
      expect(isVariantId("2026")).toBe(true);
      expect(isVariantId("2027")).toBe(false);
    });
  });
});
