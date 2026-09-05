import { searchProvider } from "@/config/map-config";
import type { BBox } from "@/layers/box-filter";
import { nominatimProvider } from "@/tools/geocode/nominatim";
import { pdokProvider } from "@/tools/geocode/pdok";
import type { GeocodeProvider, GeocodeProviderId, GeocodeResult } from "@/tools/geocode/types";

export type { GeocodeProviderId, GeocodeResult } from "@/tools/geocode/types";

/**
 * The one way into geocoding.
 *
 * Both callers come through here — the search box's suggestion list and the
 * `zoom_to_location` tool — so the choice of backend, the empty-query guard and
 * the failure handling exist once rather than per provider or per call site.
 */

const PROVIDERS: Record<GeocodeProviderId, GeocodeProvider> = {
  pdok: pdokProvider,
  nominatim: nominatimProvider,
};

/**
 * How many candidates the search box offers.
 *
 * Five is what fits under the input without turning the popover into a page.
 */
export const MAX_GEOCODE_RESULTS = 5;

/** The backend `map.json` selected. */
function activeProvider(): GeocodeProvider {
  return PROVIDERS[searchProvider()];
}

/**
 * Ranked candidates for a (possibly partial) query, best first.
 *
 * **Never throws, and never returns null** — a geocoder is a remote service on
 * the far side of a network, so "it did not answer" is an ordinary outcome that
 * shows up as an empty list. Callers render "nothing found" either way.
 */
export async function geocode(
  query: string,
  limit: number = MAX_GEOCODE_RESULTS,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    return await activeProvider().search(trimmed, limit, signal);
  } catch (err) {
    // An abort is this app cancelling its own request because the user kept
    // typing — routine, and not worth a console line on every keystroke.
    if (err instanceof DOMException && err.name === "AbortError") return [];
    console.error("Search failed:", err);
    return [];
  }
}

/**
 * The extent of a candidate the user picked, or `undefined`.
 *
 * Separate from {@link geocode} because it costs a second request under PDOK and
 * is only worth making for the one result actually chosen. Providers that
 * already return extents have nothing to do here.
 */
export async function geocodeExtent(
  result: GeocodeResult,
  signal?: AbortSignal,
): Promise<BBox | undefined> {
  if (result.bbox) return result.bbox;

  const provider = activeProvider();
  if (!provider.resolveExtent) return undefined;

  try {
    return await provider.resolveExtent(result, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return undefined;
    // Not fatal: without an extent the caller still flies to the centre, so a
    // failed lookup costs framing, not the search itself.
    console.warn("Could not resolve the area extent:", err);
    return undefined;
  }
}
