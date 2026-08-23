import { describe, it, expect, vi } from "vitest";
import {
  registerVariantScopedCache,
  clearVariantScopedCaches,
  variantScopedCacheCount,
} from "@/config/variant-scope";

/**
 * The registry exists so a variant-scoped cache cannot be forgotten: it is
 * declared where the cache is, not in a list the switch has to maintain.
 */
describe("variant-scoped cache registry", () => {
  it("clears every registered cache", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerVariantScopedCache(a);
    registerVariantScopedCache(b);

    clearVariantScopedCaches();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("keeps registrations across switches", () => {
    const clear = vi.fn();
    registerVariantScopedCache(clear);

    clearVariantScopedCaches();
    clearVariantScopedCaches();

    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("registers a given function once", () => {
    const clear = vi.fn();
    const before = variantScopedCacheCount();
    registerVariantScopedCache(clear);
    registerVariantScopedCache(clear);
    expect(variantScopedCacheCount()).toBe(before + 1);

    clearVariantScopedCaches();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  // Importing a module is what registers its cache. Each of these asserts the
  // count ROSE when the module was pulled in — a plain total would pass on the
  // spies other tests register, so dropping a real registration would hide.
  //
  // Every one of these caches is keyed by layer id, and ids are reused between
  // variants: uncleared, they answer with the other year's value and nothing
  // logs anything.
  it.each([
    ["@/layers/feature-id", () => import("@/layers/feature-id")],
    [
      "@/components/ui/navigation/LayerDescription",
      () => import("@/components/ui/navigation/LayerDescription"),
    ],
    ["@/components/ui/navigation/LeafMeta", () => import("@/components/ui/navigation/LeafMeta")],
  ])("%s registers a variant-scoped cache", async (_name, load) => {
    // vitest caches modules per file, so force a fresh evaluation. The count
    // may rise by more than one — these UI modules import each other, and each
    // brings its own cache — so the assertion is "this import registered
    // something", which is what dropping a registration would break.
    vi.resetModules();
    const scope = await import("@/config/variant-scope");
    const before = scope.variantScopedCacheCount();
    await load();
    expect(scope.variantScopedCacheCount()).toBeGreaterThan(before);
  });
});
