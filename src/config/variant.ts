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
 * When a project declares no variants — any but startanalyse2026 and woonzorglimburg —
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

/**
 * Base URL the config files are fetched from. Empty means this origin, which
 * is every deployment that does not use `?config=` and is the only behaviour
 * before that parameter existed.
 *
 * A plain variable, not a signal: it is resolved once in main.tsx before the
 * first fetch and never changes afterwards. Switching config sources mid-session
 * would mean tearing down every layer, cache and map source, which is what a
 * page load already does.
 */
let configBaseValue = "";

/** The active config base; `""` for this origin. See {@link setConfigBase}. */
export function configBase(): string {
  return configBaseValue;
}

/**
 * Point the config loaders at `base` (already canonical and allowlisted — see
 * config-source.ts). Must be called before anything fetches a config file.
 */
export function setConfigBase(base: string): void {
  configBaseValue = base.replace(/\/+$/, "");
}

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
  setVariantIdSignal(bootVariantId(variants));
}

/**
 * The variant a page load starts in: `?variant=` when it names a declared
 * variant, otherwise `variants.default`, otherwise the first item.
 *
 * Separate from {@link initVariants} because map.json needs the answer while it
 * is still being parsed — a variant may override boot-time feature flags (see
 * `VariantItem`), and those are resolved before the variant system exists. One
 * function for both, so the flags and the data can never come from different
 * variants on the same load.
 */
export function bootVariantId(variants: VariantsConfig): string {
  const requested = new URLSearchParams(window.location.search).get(VARIANT_PARAM);
  if (requested && variants.items.some((item) => item.id === requested)) return requested;
  return variants.default ?? variants.items[0].id;
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
  const suffix = !id || !PER_VARIANT_FILES.has(name) ? `/${name}` : `/${id}/${name}`;
  // Prefixed rather than built with `new URL`, so a remote folder keeps the
  // exact same `/<variant>/<name>.json` shape as `configs/<slug>/` on disk.
  return configBaseValue ? `${configBaseValue}${suffix}` : suffix;
}

/**
 * Key for caching a per-variant file's parsed result. Files that are not
 * per-variant share one key across variants, so they are parsed once.
 */
export function variantCacheKey(name: string): string {
  const id = variantId();
  return !id || !PER_VARIANT_FILES.has(name) ? "" : id;
}
