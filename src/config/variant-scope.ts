/**
 * Caches that mean something different under a different config variant.
 *
 * Layer ids are reused between variants — "374" is a layer in both the 2025 and
 * the 2026 catalogue — so anything keyed by id holds a value that is wrong, not
 * merely stale, once the variant changes. Nothing errors: the map keeps working
 * and shows the other year's answer.
 *
 * A cache registers itself where it is declared, so adding one is a single call
 * next to the `new Map()` rather than a remembered edit in the switch. The
 * switch clears whatever registered.
 *
 * Caches keyed by URL do NOT belong here: a URL names the same document
 * whichever variant asked for it, and re-fetching it would be pure waste. See
 * `metaCache` in LeafMeta.tsx and `archiveFields` in feature-id.ts.
 */
const registered = new Set<() => void>();

/**
 * Register a cache to be cleared on every variant switch. Returns nothing; the
 * registration lasts for the life of the module.
 */
export function registerVariantScopedCache(clear: () => void): void {
  registered.add(clear);
}

/** Clear every registered cache. Called by the variant switch. */
export function clearVariantScopedCaches(): void {
  for (const clear of registered) clear();
}

/** How many caches are registered — for tests asserting nothing was dropped. */
export function variantScopedCacheCount(): number {
  return registered.size;
}
