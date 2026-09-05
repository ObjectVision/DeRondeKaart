import type { BBox } from "@/layers/box-filter";

/**
 * The little WKT this app needs: a point's coordinate, and a polygon's envelope.
 *
 * PDOK's Locatieserver hands geometry back as WKT text (`centroide_ll`,
 * `geometrie_ll`) rather than GeoJSON, and the repo's only other geometry reader
 * — `box-filter.ts` — decodes WKB, the binary form. So this is the text
 * counterpart, kept deliberately small: the two shapes the geocoder reads, and
 * nothing else.
 *
 * **Coordinates are lon-lat**, matching PDOK's `_ll` fields and {@link BBox}'s
 * `[minLng, minLat, maxLng, maxLat]`. PDOK also serves `_rd` fields in the Dutch
 * RD grid (metres, x-y); this code would return plausible-looking nonsense for
 * those, so read the `_ll` variants only.
 *
 * Everything returns `null` rather than throwing: the input is a remote API's
 * string, so a malformed one is an ordinary outcome the caller already handles
 * by dropping the candidate.
 */

/** One `<number> <number>` pair, as WKT writes coordinates. */
const COORD_PAIR = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;

/** Whether `wkt` is a string whose first word is `type` (case-insensitive). */
function hasGeometryType(wkt: unknown, type: string): wkt is string {
  return typeof wkt === "string" && new RegExp(`^\\s*${type}\\s*\\(`, "i").test(wkt);
}

/**
 * The coordinate of a WKT `POINT(lon lat)`, or `null`.
 *
 * Rejects any other geometry rather than reading its first vertex: a POLYGON
 * passed here by mistake would otherwise yield one arbitrary corner, which is a
 * wrong answer that looks right. A `null` surfaces the mix-up instead.
 */
export function parseWktPoint(wkt: unknown): [number, number] | null {
  if (!hasGeometryType(wkt, "POINT")) return null;

  COORD_PAIR.lastIndex = 0;
  const match = COORD_PAIR.exec(wkt);
  if (!match) return null;

  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/**
 * Geometries that enclose an area or a length — anything with an extent worth
 * framing.
 *
 * Lines belong here as much as polygons do: PDOK returns a street as a
 * MULTILINESTRING, and it has a perfectly good extent. Leaving them out meant a
 * street search threw its own geometry away and fell back to a default zoom
 * three levels too wide.
 *
 * Every name must be listed explicitly. {@link hasGeometryType} anchors its
 * match at the start of the string, so "POLYGON" does not match
 * "MULTIPOLYGON(...)" and "LINESTRING" does not match "MULTILINESTRING(...)" —
 * dropping one silently reintroduces the bug for that type alone.
 */
const EXTENT_TYPES = ["POLYGON", "MULTIPOLYGON", "LINESTRING", "MULTILINESTRING"];

/**
 * The bounding box of any WKT geometry with an extent, or `null`.
 *
 * Structure is deliberately not parsed. An envelope is the min/max over every
 * coordinate, and interior rings lie inside their exterior by definition, so
 * sweeping all pairs gives the same answer as walking the nesting — which is why
 * this is a few lines rather than a WKT library. It also means a MULTIPOLYGON's
 * or MULTILINESTRING's separate parts are unioned for free, the case a reader
 * that stopped at the first ring would get wrong.
 *
 * Rejects POINT for the same reason {@link parseWktPoint} rejects polygons: a
 * degenerate box built from one vertex would frame nothing.
 */
export function wktBbox(wkt: unknown): BBox | null {
  // Narrowed up front rather than relying on the type guard below:
  // `hasGeometryType` is a type predicate, but TypeScript cannot carry that
  // narrowing out of a `.some()` callback, so the sweep would still see
  // `unknown`.
  if (typeof wkt !== "string") return null;
  if (!EXTENT_TYPES.some((type) => hasGeometryType(wkt, type))) return null;

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let count = 0;

  COORD_PAIR.lastIndex = 0;
  for (let m = COORD_PAIR.exec(wkt); m !== null; m = COORD_PAIR.exec(wkt)) {
    const lng = Number(m[1]);
    const lat = Number(m[2]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    count++;
  }

  // A polygon needs more than a single vertex to have an extent worth flying to.
  if (count < 2) return null;
  return [minLng, minLat, maxLng, maxLat];
}
