import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMapConfig } from "@/config/map-config";
import { nominatimProvider } from "@/tools/geocode/nominatim";

/**
 * The Nominatim provider.
 *
 * The `countrycodes` cases came here from `zoom-to-location.test.ts` when the
 * geocoder moved behind a provider layer — they now test the provider that
 * builds the URL rather than the wrapper that no longer does.
 *
 * Only the FIRST result is used on the headless tool path, so an unrestricted
 * search has no list for the user to correct from: "Bergen" answers with Bergen
 * in Norway, though it is also a town in Noord-Holland and another in Limburg.
 * `mapControls.searchCountries` is what prevents that.
 */

/** Point `loadMapConfig` at a map.json body. */
function stubMapJson(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, statusText: "OK", json: async () => body })),
  );
}

/** Stub the geocoder response, and hand back the spy. */
function stubFetch(payload: unknown, ok = true) {
  const spy = vi.fn<(url: string) => Promise<unknown>>(async () => ({
    ok,
    status: ok ? 200 : 403,
    statusText: ok ? "OK" : "Forbidden",
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Load a config, then run a search and return the URL it used. */
async function searchWithConfig(
  mapControls: Record<string, unknown>,
  query = "Bergen",
): Promise<string> {
  stubMapJson({ mapControls: { search: true, ...mapControls } });
  await loadMapConfig();
  vi.unstubAllGlobals();

  const spy = stubFetch([]);
  await nominatimProvider.search(query, 5);
  return String(spy.mock.calls[0]?.[0] ?? "");
}

const PLACE = {
  place_id: 42,
  display_name: "Venlo, Limburg, Nederland",
  type: "town",
  lat: "51.3704",
  lon: "6.1724",
};

afterEach(() => vi.unstubAllGlobals());

describe("nominatimProvider country restriction", () => {
  it("restricts to the configured countries", async () => {
    const url = await searchWithConfig({ searchCountries: ["nl"] });

    expect(url).toContain("countrycodes=nl");
    expect(url).toContain("q=Bergen");
  });

  /**
   * The case that protects woonzorglimburg, which names no countries: the
   * parameter must be absent entirely, not sent empty. `countrycodes=` would be
   * a filter matching nothing.
   */
  it("sends no countrycodes when none are configured", async () => {
    const url = await searchWithConfig({});

    expect(url).not.toContain("countrycodes");
  });

  it("joins several countries for a project spanning a border", async () => {
    const url = await searchWithConfig({ searchCountries: ["nl", "de", "be"] }, "Aachen");

    expect(url).toContain("countrycodes=nl%2Cde%2Cbe");
  });
});

describe("nominatimProvider.search", () => {
  it("honours the row limit", async () => {
    const spy = stubFetch([]);

    await nominatimProvider.search("Venlo", 5);

    expect(String(spy.mock.calls[0]?.[0])).toContain("limit=5");
  });

  it("maps a place, putting lon before lat", async () => {
    stubFetch([PLACE]);

    const [first] = await nominatimProvider.search("Venlo", 5);

    expect(first.label).toBe("Venlo, Limburg, Nederland");
    expect(first.center).toEqual([6.1724, 51.3704]);
    expect(first.id).toBe("42");
  });

  /**
   * The likeliest silent bug in the whole provider layer. Nominatim sends
   * `[minLat, maxLat, minLon, maxLon]`; BBox is `[minLng, minLat, maxLng,
   * maxLat]`. Passed through unchanged, "Venlo" would frame a box off the coast
   * of Somalia — plausible-looking numbers, entirely the wrong place.
   */
  it("reorders the bounding box from lat-major to lon-major", async () => {
    stubFetch([{ ...PLACE, boundingbox: ["51.3", "51.4", "6.1", "6.2"] }]);

    const [first] = await nominatimProvider.search("Venlo", 5);

    expect(first.bbox).toEqual([6.1, 51.3, 6.2, 51.4]);
  });

  it("leaves bbox undefined when the response carries none", async () => {
    stubFetch([PLACE]);

    const [first] = await nominatimProvider.search("Venlo", 5);

    expect(first.bbox).toBeUndefined();
  });

  it("ignores a malformed bounding box rather than flying somewhere wrong", async () => {
    stubFetch([{ ...PLACE, boundingbox: ["51.3", "oops"] }]);

    const [first] = await nominatimProvider.search("Venlo", 5);

    expect(first.bbox).toBeUndefined();
  });

  // Coordinates make a hit usable; a missing label is a presentation detail.
  it("keeps a place with coordinates but no display name", async () => {
    stubFetch([{ lat: "50.85", lon: "5.69" }]);

    const [first] = await nominatimProvider.search("Maastricht", 5);

    expect(first.center).toEqual([5.69, 50.85]);
    expect(first.label).toBe("Maastricht");
  });

  it("drops a place with unusable coordinates", async () => {
    stubFetch([{ ...PLACE, lat: "x", lon: "y" }, PLACE]);

    const results = await nominatimProvider.search("Venlo", 5);

    expect(results).toHaveLength(1);
  });

  it("returns nothing when the response is not a list", async () => {
    stubFetch({ error: "Unable to geocode" });

    await expect(nominatimProvider.search("Atlantis", 5)).resolves.toEqual([]);
  });

  /**
   * Nominatim answers an impolite client with 403/429. Before the provider
   * layer this went unchecked and surfaced as a confusing JSON parse failure.
   */
  it("throws on an HTTP error rather than parsing the error page", async () => {
    stubFetch([], false);

    await expect(nominatimProvider.search("Venlo", 5)).rejects.toThrow(/403/);
  });
});
