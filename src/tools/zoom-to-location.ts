import { flyToBbox, flyToView } from "@/lib/fly-to";
import { geocode, geocodeExtent, type GeocodeResult } from "@/tools/geocode";

/**
 * Flying the map to a place.
 *
 * The geocoding itself lives in `@/tools/geocode`, behind a configurable
 * provider. What is left here is the part both callers share: how a candidate
 * becomes a camera move.
 *
 * Two callers, one path. The search box lists candidates and calls
 * {@link flyToResult} with the one the user picked; the `zoom_to_location` tool
 * is headless and calls {@link zoomToLocation}, which takes the best hit and
 * hands it to the very same function. Keeping the tool defined in terms of the
 * UI's own primitives is what stops the two from drifting apart — framing
 * changed in one place is framing changed in both.
 */

/**
 * How close to fly for a hit with no extent of its own.
 *
 * PDOK returns an address and a postcode as a bare `POINT` — nothing to frame,
 * so the zoom has to be chosen rather than derived from a box. Left unset, the
 * map's flyto listener substitutes 12, which spans roughly 24 km: a whole town
 * for a single house number.
 *
 * 17 puts a building in its street with the neighbouring blocks still visible
 * (~750 m across). A postcode sits one level wider because a Dutch six-digit
 * code covers a street segment of roughly 20-40 addresses, not one building.
 *
 * Keyed on `kind` because the two are geometrically identical — both arrive as
 * a bare POINT — so the presence of a bbox cannot tell them apart. The `??`
 * default is what keeps that safe: a PDOK type nobody has seen before gets
 * sensible framing rather than breaking the search.
 */
const POINT_ZOOM: Record<string, number> = { adres: 17, postcode: 16 };

/** Point-like, but of a kind we do not recognise: close, not building-tight. */
const DEFAULT_POINT_ZOOM = 16;

/**
 * Fly to one candidate: frame its extent when it has one, else centre on it at
 * a zoom chosen for what kind of thing it is.
 *
 * The extent is fetched here rather than during the search because under PDOK
 * it costs a second request, and only the picked candidate is worth it.
 */
export async function flyToResult(result: GeocodeResult): Promise<void> {
  const bbox = await geocodeExtent(result);
  if (bbox) flyToBbox(bbox);
  else flyToView(result.center, POINT_ZOOM[result.kind] ?? DEFAULT_POINT_ZOOM);
}

/**
 * Geocode a place name and fly every mounted map to the best match.
 *
 * The headless path, used by the `zoom_to_location` tool and by the command bar
 * whenever the language model is unavailable — so this is what plain typed text
 * still does, exactly as it did before the search grew a candidate list.
 *
 * Asks for a single row: the AI has no list to show, so fetching five would be
 * four candidates nobody sees. This assumes neither provider's ranking depends
 * on how many rows are requested — true of both today, but it is an assumption
 * about a remote API rather than something this code can enforce.
 */
export async function zoomToLocation(location: string): Promise<boolean> {
  const [best] = await geocode(location, 1);
  if (!best) return false;

  await flyToResult(best);
  return true;
}
