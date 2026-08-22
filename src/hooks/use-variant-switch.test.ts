import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { initVariants, variantId } from "@/config/variant";
import { loadLayerConfigs } from "@/layers";
import { clearLayerConfigCache } from "@/layers/config";
import { loadNavigation, clearNavigationCache } from "@/layers/navigation";
import { useVariantSwitch } from "./use-variant-switch";
import type { VariantsConfig } from "@/config/map-config";

const VARIANTS: VariantsConfig = {
  default: "2025",
  items: [
    { id: "2025", label: "Startanalyse 2025" },
    { id: "2026", label: "Startanalyse 2026" },
  ],
};

/**
 * Serve a distinct layers.json / navigation.json per variant prefix, and record
 * every URL requested so a test can assert the cache stopped a refetch.
 */
const requested: string[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(url);
      const year = url.startsWith("/2026/") ? "2026" : "2025";
      const body = url.endsWith("layers.json")
        ? { layers: [{ id: "374", name: `Laagste kosten ${year}`, format: "mvt", source: "x" }] }
        : [{ label: `Kernkaarten ${year}`, children: [] }];
      return { ok: true, statusText: "OK", json: async () => body };
    }),
  );
}

/** A map side with a spy-able layer stack, shaped like useMapLayers' result. */
function fakeSide(ids: string[]) {
  let entries = ids.map((id) => ({ config: { id } }));
  const removeLayer = vi.fn((id: string) => {
    entries = entries.filter((e) => e.config.id !== id);
  });
  return {
    layers: {
      layerEntries: () => entries,
      removeLayer,
    } as never,
    view: () => null,
    removeLayer,
    remaining: () => entries.map((e) => e.config.id),
  };
}

describe("useVariantSwitch", () => {
  beforeEach(() => {
    requested.length = 0;
    stubFetch();
    clearLayerConfigCache();
    clearNavigationCache();
    window.history.replaceState({}, "", "/");
    initVariants(VARIANTS);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the default variant's files first", async () => {
    expect(variantId()).toBe("2025");
    const configs = await loadLayerConfigs();
    expect(configs[0].name).toBe("Laagste kosten 2025");
    expect(requested).toContain("/2025/layers.json");
  });

  it("removes every layer from both maps and repoints the configs", async () => {
    await loadLayerConfigs();
    const left = fakeSide(["374", "357"]);
    const right = fakeSide(["374"]);

    await createRoot(async (dispose) => {
      const { switchVariant } = useVariantSwitch({ mapLeft: left, mapRight: right });
      const ok = await switchVariant("2026");
      expect(ok).toBe(true);
      dispose();
    });

    // Every entry gone from both sides — the whole point of the teardown.
    expect(left.remaining()).toEqual([]);
    expect(right.remaining()).toEqual([]);
    expect(left.removeLayer).toHaveBeenCalledTimes(2);
    expect(right.removeLayer).toHaveBeenCalledTimes(1);

    expect(variantId()).toBe("2026");
    const configs = await loadLayerConfigs();
    expect(configs[0].name).toBe("Laagste kosten 2026");
    const nav = await loadNavigation();
    expect(nav[0].label).toBe("Kernkaarten 2026");
  });

  it("does not refetch when switching back to a variant already parsed", async () => {
    const left = fakeSide([]);
    const right = fakeSide([]);

    await createRoot(async (dispose) => {
      const { switchVariant } = useVariantSwitch({ mapLeft: left, mapRight: right });
      // First visit to each variant fetches its two files.
      await switchVariant("2026");
      await switchVariant("2025");
      const afterBothSeen = [...requested];
      expect(afterBothSeen).toEqual([
        "/2026/layers.json",
        "/2026/navigation.json",
        "/2025/layers.json",
        "/2025/navigation.json",
      ]);

      // Every later switch is served from the per-variant cache. This is what
      // keeps a toggle from re-paying the 1.9 MB parse plus the PMTiles
      // prefetch, which is what would make it feel like a page reload.
      await switchVariant("2026");
      await switchVariant("2025");
      expect(requested).toEqual(afterBothSeen);
      dispose();
    });
  });

  it("leaves the maps untouched for an unknown variant", async () => {
    const left = fakeSide(["374"]);
    const right = fakeSide([]);

    await createRoot(async (dispose) => {
      const { switchVariant } = useVariantSwitch({ mapLeft: left, mapRight: right });
      expect(await switchVariant("1999")).toBe(false);
      dispose();
    });

    expect(left.remaining()).toEqual(["374"]);
    expect(left.removeLayer).not.toHaveBeenCalled();
    expect(variantId()).toBe("2025");
  });

  it("is a no-op when the requested variant is already active", async () => {
    const left = fakeSide(["374"]);
    const right = fakeSide([]);

    await createRoot(async (dispose) => {
      const { switchVariant } = useVariantSwitch({ mapLeft: left, mapRight: right });
      expect(await switchVariant("2025")).toBe(false);
      dispose();
    });

    expect(left.remaining()).toEqual(["374"]);
    expect(left.removeLayer).not.toHaveBeenCalled();
  });
});
