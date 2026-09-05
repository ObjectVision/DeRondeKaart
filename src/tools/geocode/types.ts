import type { BBox } from "@/layers/box-filter";

/**
 * The geocoding backends the location search can use.
 *
 * Kept here rather than in `map-config.ts` so the config module can import the
 * union as a type only, without pulling in any provider code. `box-filter`
 * imports nothing from the app, so this direction stays cycle-free.
 */
export type GeocodeProviderId = "pdok" | "nominatim";

/** One ranked candidate, in the shape the UI and the tool path both consume. */
export interface GeocodeResult {
  /** Stable per-provider id; the list key, and what a lookup is keyed on. */
  id: string;
  /** Display label, already human-readable ("Gemeente Bergen (L)"). */
  label: string;
  /**
   * The provider's own kind — "gemeente", "woonplaats", "adres", … Free text,
   * and shown as a secondary label.
   *
   * Read in one place only: how close to fly for a hit with no extent, since an
   * address and a postcode are geometrically identical (both bare points) and
   * nothing else distinguishes them. That lookup always falls back to a default,
   * so a provider inventing a new kind still gets sensible framing — it can
   * never break routing.
   */
  kind: string;
  /** `[lon, lat]`. Always present — a candidate we cannot fly to is not one. */
  center: [number, number];
  /**
   * Extent to frame, when the provider supplied one without an extra request.
   * Absent for genuinely point-like hits (an address, a postcode), which are
   * flown to by their centre instead. A street is NOT one of those: it has a
   * real extent, and framing it is what stops a street search showing a town.
   */
  bbox?: BBox;
}

/**
 * A geocoding backend.
 *
 * Implementations may reject; {@link geocode} owns the single try/catch, so
 * failure handling is not repeated per provider.
 */
export interface GeocodeProvider {
  /** Matches the `map.json` value, so a config selects a provider by name. */
  readonly id: GeocodeProviderId;
  /** Ranked candidates, best first, at most `limit`. */
  search(query: string, limit: number, signal?: AbortSignal): Promise<GeocodeResult[]>;
  /**
   * The extent for one candidate, when it takes a second request to get.
   *
   * Optional: a provider whose `search` already returns extents omits this, and
   * the caller then simply has nothing more to fetch.
   */
  resolveExtent?(result: GeocodeResult, signal?: AbortSignal): Promise<BBox | undefined>;
}
