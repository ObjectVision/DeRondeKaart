import { searchCountries } from "@/config/map-config";
import type { BBox } from "@/layers/box-filter";
import type { GeocodeProvider, GeocodeResult } from "@/tools/geocode/types";

/**
 * Nominatim (OpenStreetMap) — the worldwide geocoder, and the default.
 *
 * Moved here from `zoom-to-location.ts` when the search gained a provider
 * layer. The behaviour is the same, with two differences: it returns a LIST
 * rather than the single best hit, and it now checks `res.ok` — Nominatim
 * answers an unpolite client with 403/429, which used to surface as a confusing
 * JSON parse failure rather than as the HTTP error it is.
 *
 * `mapControls.searchCountries` restricts it. Worth setting wherever a project
 * covers one country: "Bergen" otherwise answers with Bergen in Norway, though
 * it is also a town in Noord-Holland and another in Limburg. The `pdok`
 * provider has no such problem and ignores the setting.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** One result as Nominatim returns it. */
interface NominatimPlace {
  place_id?: unknown;
  display_name?: unknown;
  type?: unknown;
  lat?: unknown;
  lon?: unknown;
  boundingbox?: unknown;
}

/**
 * Nominatim's `boundingbox` as a {@link BBox}, or `undefined`.
 *
 * **The axes differ.** Nominatim sends `[minLat, maxLat, minLon, maxLon]` as
 * strings; `BBox` is `[minLng, minLat, maxLng, maxLat]`. Passing it straight
 * through would fly the map to a transposed box somewhere off the coast of
 * Somalia, so the reorder is the whole reason this function exists.
 */
function toBbox(raw: unknown): BBox | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined;

  const [minLat, maxLat, minLng, maxLng] = raw.map(Number);
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return undefined;

  return [minLng, minLat, maxLng, maxLat];
}

/**
 * One place as a {@link GeocodeResult}, or `null` without usable coordinates.
 *
 * Coordinates are the only hard requirement: they are what makes a candidate
 * flyable, and the headless tool path never reads the label at all. A place
 * missing its `display_name` therefore falls back to the query rather than
 * being discarded — dropping a good coordinate over a presentation detail would
 * turn a working search into "niets gevonden".
 */
function toResult(place: NominatimPlace, query: string): GeocodeResult | null {
  const lat = parseFloat(String(place.lat));
  const lng = parseFloat(String(place.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const label = typeof place.display_name === "string" && place.display_name ? place.display_name : query;

  return {
    id: place.place_id === undefined ? label : String(place.place_id),
    label,
    kind: typeof place.type === "string" ? place.type : "",
    center: [lng, lat],
    bbox: toBbox(place.boundingbox),
  };
}

export const nominatimProvider: GeocodeProvider = {
  id: "nominatim",

  async search(query: string, limit: number, signal?: AbortSignal) {
    const params = new URLSearchParams({
      q: query,
      format: "json",
      limit: String(limit),
    });

    // Only when a project names any: `countrycodes=` with an empty value is a
    // filter matching nothing, so the parameter must be absent rather than blank.
    const countries = searchCountries();
    if (countries.length > 0) params.set("countrycodes", countries.join(","));

    const res = await fetch(`${ENDPOINT}?${params}`, { signal });
    if (!res.ok) throw new Error(`Nominatim: ${res.status} ${res.statusText}`);

    const body = await res.json();
    if (!Array.isArray(body)) return [];

    return (body as NominatimPlace[])
      .map((place) => toResult(place, query))
      .filter((r): r is GeocodeResult => r !== null);
  },

  // No `resolveExtent`: `boundingbox` already rides along with every result, so
  // there is nothing left to fetch.
};
