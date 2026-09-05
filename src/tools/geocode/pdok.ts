import type { BBox } from "@/layers/box-filter";
import { parseWktPoint, wktBbox } from "@/lib/wkt-bbox";
import type { GeocodeProvider, GeocodeResult } from "@/tools/geocode/types";

/**
 * PDOK Locatieserver — the Dutch government's authoritative geocoder.
 *
 * Netherlands-only by construction, which is the point: it ranks "Bergen" as
 * Bergen (L) first, where a worldwide geocoder answers with Bergen in Norway.
 * For the same reason `mapControls.searchCountries` is IGNORED here — there is
 * no country to choose. Configs may still carry it for the nominatim provider.
 *
 * Two endpoints, for two different jobs:
 *
 * - **`suggest`** builds the candidate list. Not `free`: `free` matches whole
 *   terms only and answers a partial like "Venl" with *nothing*, which is
 *   useless for a list that updates while the user types. `suggest` returns the
 *   expected five.
 * - **`lookup`** fetches one candidate's geometry, and only once the user has
 *   picked it. Asking `suggest` for `geometrie_ll` inflates the response about
 *   11× (1KB to 12KB for five rows, 18KB for Amsterdam), nearly all of it for
 *   candidates nobody chose.
 */

const BASE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";

/**
 * Fields the list request asks for.
 *
 * `fl` is a whitelist: a field left out of it is simply absent from the
 * response, with no error, so this must name everything {@link toResult} reads.
 */
const LIST_FIELDS = "id,weergavenaam,type,centroide_ll";

/** One document as Locatieserver returns it; every field is optional to us. */
interface PdokDoc {
  id?: unknown;
  weergavenaam?: unknown;
  type?: unknown;
  centroide_ll?: unknown;
  geometrie_ll?: unknown;
}

/** The documents from a Locatieserver response body, or `[]`. */
function docsOf(body: unknown): PdokDoc[] {
  const docs = (body as { response?: { docs?: unknown } } | null)?.response?.docs;
  return Array.isArray(docs) ? (docs as PdokDoc[]) : [];
}

/**
 * One document as a {@link GeocodeResult}, or `null` when it has no usable
 * centroid — a candidate the map cannot fly to is not a candidate.
 *
 * A missing `weergavenaam` is not disqualifying in the same way: the coordinate
 * is what makes the result useful, and the tool path never reads the label. It
 * falls back to the query rather than costing the user a working hit.
 */
function toResult(doc: PdokDoc, query: string): GeocodeResult | null {
  const center = parseWktPoint(doc.centroide_ll);
  if (!center) return null;

  const label =
    typeof doc.weergavenaam === "string" && doc.weergavenaam ? doc.weergavenaam : query;

  const kind = typeof doc.type === "string" ? doc.type : "";
  return {
    id: typeof doc.id === "string" ? doc.id : `${kind}:${label}`,
    label,
    kind,
    center,
  };
}

export const pdokProvider: GeocodeProvider = {
  id: "pdok",

  async search(query: string, limit: number, signal?: AbortSignal) {
    const params = new URLSearchParams({
      q: query,
      rows: String(limit),
      fl: LIST_FIELDS,
    });

    const res = await fetch(`${BASE}/suggest?${params}`, { signal });
    if (!res.ok) throw new Error(`PDOK suggest: ${res.status} ${res.statusText}`);

    // PDOK's own `typesortering` already orders these (gemeente before
    // woonplaats before street), and it is what produces the verified
    // Bergen(L)-first result. Re-sorting here would be a second ranking policy
    // to keep in step with theirs, so the order is passed through untouched.
    return docsOf(await res.json())
      .map((doc) => toResult(doc, query))
      .filter((r): r is GeocodeResult => r !== null);
  },

  /**
   * The picked candidate's extent, so the map frames a gemeente rather than
   * dropping a pin in the middle of it.
   *
   * An address's `geometrie_ll` is itself a POINT, which {@link wktBbox}
   * rejects — so this returns `undefined` for point-like hits and the caller
   * falls back to the centroid, with no type test needed here.
   */
  async resolveExtent(result: GeocodeResult, signal?: AbortSignal): Promise<BBox | undefined> {
    const params = new URLSearchParams({ id: result.id, fl: "geometrie_ll" });

    const res = await fetch(`${BASE}/lookup?${params}`, { signal });
    if (!res.ok) throw new Error(`PDOK lookup: ${res.status} ${res.statusText}`);

    const doc = docsOf(await res.json())[0];
    return wktBbox(doc?.geometrie_ll) ?? undefined;
  },
};
