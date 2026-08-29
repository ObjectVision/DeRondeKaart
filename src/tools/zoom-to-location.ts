import { searchCountries } from "@/config/map-config";
import { flyToView } from "@/lib/fly-to";

/**
 * Geocode a place name and fly every mounted map to it.
 *
 * Moved here verbatim from the search popover in `map-controls.tsx`: it is now
 * one of the map tools a natural-language command can resolve to, and the
 * search bar calls it through the same path rather than owning the logic.
 */
export async function zoomToLocation(location: string): Promise<boolean> {
  const query = location.trim();
  if (!query) return false;

  try {
    const params = new URLSearchParams({ q: query, format: "json", limit: "1" });
    // Restrict to the configured countries, when a project names any. Only the
    // FIRST result is used, so an unrestricted search has no list for the user
    // to correct from: "Bergen" answers with Bergen in Norway, though it is
    // also a town in Noord-Holland and another in Limburg.
    const countries = searchCountries();
    if (countries.length > 0) params.set("countrycodes", countries.join(","));

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return false;

    const { lat, lon } = results[0];
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

    flyToView([longitude, latitude]);
    return true;
  } catch (err) {
    console.error("Search failed:", err);
    return false;
  }
}
