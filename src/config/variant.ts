import { createSignal } from "solid-js";
import type { VariantsConfig } from "@/config/map-config";

/**
 * Runtime config variants — two datasets (e.g. model years 2025 and 2026)
 * shipped in one build and switched without reloading the app.
 *
 * A project opts in with a `variants` block in map.json. The variant's files
 * live in a subdirectory of the project config dir and are served from a
 * matching URL prefix (`configs/<slug>/2026/layers.json` → `/2026/layers.json`,
 * see the config-overlay plugin in vite.config.ts).
 *
 * Only `layers.json` and `navigation.json` are per-variant today; map.json,
 * filter.json and charts.json stay shared at the site root. {@link configPath}
 * is the one place that decides, so adding a file to the per-variant set is a
 * one-line change in {@link PER_VARIANT_FILES}.
 *
 * When a project declares no variants — every project but startanalyse2026 —
 * `variantId()` is null and `configPath()` returns the bare `/name.json` these
 * loaders always used, so nothing about their behaviour changes.
 */

/**
 * Config files that differ per variant. Everything else is fetched from the
 * site root regardless of the active variant.
 */
const PER_VARIANT_FILES = new Set(["layers.json", "navigation.json"]);

/** URL parameter that selects a variant at boot, e.g. `?variant=2026`. */
export const VARIANT_PARAM = "variant";

let config: VariantsConfig | null = null;

// A signal, not a plain variable: the navigation tree and any other consumer
// re-reads on switch. Null means "this project has no variants".
const [variantId, setVariantIdSignal] = createSignal<string | null>(null);

export { variantId };

/** The declared variants, or null when the project has none. */
export function variantsConfig(): VariantsConfig | null {
  return config;
}

/** Whether `id` names a declared variant. */
export function isVariantId(id: string): boolean {
  return !!config?.items.some((item) => item.id === id);
}

/**
 * Install the variants from map.json and pick the starting one. Called once at
 * boot, before anything fetches a per-variant config.
 *
 * Resolution order: `?variant=` in the URL, then `variants.default`, then the
 * first item. An unknown id in the URL warns and falls back rather than leaving
 * the app pointed at a directory that does not exist.
 */
export function initVariants(variants: VariantsConfig | undefined): void {
  if (!variants || variants.items.length === 0) {
    config = null;
    setVariantIdSignal(null);
    return;
  }
  config = variants;

  const requested = new URLSearchParams(window.location.search).get(VARIANT_PARAM);
  if (requested && !isVariantId(requested)) {
    console.warn(`Unknown variant "${requested}"; using the default`);
  }
  const initial =
    requested && isVariantId(requested)
      ? requested
      : (variants.default ?? variants.items[0].id);
  setVariantIdSignal(initial);
}

/**
 * Switch the active variant. Returns false (and warns) for an unknown id or
 * when the project has no variants, so callers driven by postMessage — where
 * the id comes from another page — can react rather than fail silently.
 *
 * This only moves the pointer. Tearing down the old variant's layers and
 * caches is `useVariantSwitch`'s job; call this through that hook, not directly.
 */
export function setVariant(id: string): boolean {
  if (!config) {
    console.warn(`Cannot switch to variant "${id}": this project declares none`);
    return false;
  }
  if (!isVariantId(id)) {
    console.warn(`Unknown variant "${id}"; ignoring`);
    return false;
  }
  if (variantId() === id) return false;
  setVariantIdSignal(id);
  return true;
}

/**
 * URL for a config file under the active variant.
 *
 * Reads the `variantId()` signal, so a loader calling this inside a tracking
 * scope re-runs on switch.
 */
export function configPath(name: string): string {
  const id = variantId();
  if (!id || !PER_VARIANT_FILES.has(name)) return `/${name}`;
  return `/${id}/${name}`;
}

/**
 * Key for caching a per-variant file's parsed result. Files that are not
 * per-variant share one key across variants, so they are parsed once.
 */
export function variantCacheKey(name: string): string {
  const id = variantId();
  return !id || !PER_VARIANT_FILES.has(name) ? "" : id;
}
