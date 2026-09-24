import { searchFilter } from "@/config/map-config";
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
 * What DOES narrow it is `mapControls.searchFilter`, a Solr `fq` passed
 * through verbatim: ranking Bergen (L) first still leaves Bergen (NH) and
 * Bergen op Zoom in the list, which a single-province project does not want.
 * See {@link DEFAULT_TYPES} for the catch in sending any filter at all.
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

/**
 * Locatieserver's OWN default `fq`, which we have to restate whenever we send
 * an `fq` of our own.
 *
 * This is the catch, and it is silent: `fq` is not additive on top of the
 * default, it REPLACES it. Send only `fq=provincienaam:"Limburg"` and the
 * result set stops being places — `perceel`, `wijk` and `buurt` documents come
 * through too, and `type:perceel` alone matches 33 034 documents for
 * "Maastricht". Measured on q=Maastricht: no fq gives 85 670 hits, the province
 * filter alone 85 001, and both filters together 84 950. Those 51 are the leak.
 *
 * Solr ANDs repeated `fq` parameters, so sending this one alongside ours
 * restores exactly the default behaviour, narrowed by province.
 */
const DEFAULT_TYPES = "type:(gemeente OR woonplaats OR weg OR postcode OR adres)";

/**
 * Whether a filter query constrains `type` itself.
 *
 * Anchored to a clause boundary, so a field that merely ENDS in "type" —
 * `objecttype:` — is not mistaken for one. Reading it as a type clause would
 * drop the default type filter and quietly widen the search.
 */
const MENTIONS_TYPE = /(^|[\s(])type\s*:/;

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

    // Only when a project configured one. With no filter the request carries no
    // `fq` at all, so PDOK applies its own default and the request is exactly
    // what it always was — which is why DEFAULT_TYPES is sent only here.
    const filter = searchFilter();
    if (filter) {
      // Restore the default the filter displaced, UNLESS the filter constrains
      // `type` itself. Sending both then ANDs them, and a project asking for a
      // type outside the default set — `type:perceel`, say — would get an empty
      // intersection rather than what it asked for.
      if (!MENTIONS_TYPE.test(filter)) params.append("fq", DEFAULT_TYPES);
      params.append("fq", filter);
    }

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
   * Covers streets as well as areas: PDOK sends a `weg` as a MULTILINESTRING,
   * which has an extent worth framing just as a gemeente's polygon does.
   *
   * An address or postcode's `geometrie_ll` is itself a POINT, which
   * {@link wktBbox} rejects — so this returns `undefined` for those, and the
   * caller falls back to the centroid at a fixed close zoom. No type test is
   * needed here; the WKT reader's refusal of a point is what routes them.
   */
  async resolveExtent(result: GeocodeResult, signal?: AbortSignal): Promise<BBox | undefined> {
    const params = new URLSearchParams({ id: result.id, fl: "geometrie_ll" });

    const res = await fetch(`${BASE}/lookup?${params}`, { signal });
    if (!res.ok) throw new Error(`PDOK lookup: ${res.status} ${res.statusText}`);

    const doc = docsOf(await res.json())[0];
    return wktBbox(doc?.geometrie_ll) ?? undefined;
  },
};
