import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { viewForBbox } from "@/lib/fly-to";
import type { GeocodeResult } from "@/tools/geocode";

/**
 * The camera half of the location search.
 *
 * The geocoder request itself is no longer built here — that moved behind the
 * provider layer, and its URL assertions moved with it to
 * `geocode/nominatim.test.ts` and `geocode/pdok.test.ts`. What is left to guard
 * is the contract this module owns: which candidate the headless path takes,
 * and how a candidate becomes a camera move.
 */

const geocode = vi.fn<(q: string, limit?: number) => Promise<GeocodeResult[]>>();
const geocodeExtent = vi.fn<(r: GeocodeResult) => Promise<unknown>>();

vi.mock("@/tools/geocode", () => ({
  geocode: (...args: [string, number?]) => geocode(...args),
  geocodeExtent: (...args: [GeocodeResult]) => geocodeExtent(...args),
  MAX_GEOCODE_RESULTS: 5,
}));

const { flyToResult, zoomToLocation } = await import("@/tools/zoom-to-location");

function result(over: Partial<GeocodeResult> = {}): GeocodeResult {
  return { id: "1", label: "Venlo", kind: "woonplaats", center: [6.17, 51.37], ...over };
}

/** Record every `map:flyto` the code under test dispatches. */
let flights: { longitude: number; latitude: number; zoom?: number }[];
function onFly(e: Event) {
  flights.push((e as CustomEvent).detail);
}

beforeEach(() => {
  flights = [];
  window.addEventListener("map:flyto", onFly);
  geocode.mockReset();
  geocodeExtent.mockReset();
  geocodeExtent.mockResolvedValue(undefined);
});

afterEach(() => window.removeEventListener("map:flyto", onFly));

describe("zoomToLocation", () => {
  /**
   * The AI tool has no list to offer, so "the best match" must be exactly the
   * candidate the search box would put at the top. Both paths read index 0 of
   * the same ranked list, which is what keeps them from drifting apart.
   */
  it("flies to the first of several candidates", async () => {
    geocode.mockResolvedValue([
      result({ label: "Bergen (L)", center: [6.08, 51.59] }),
      result({ label: "Bergen (NH)", center: [4.66, 52.66] }),
    ]);

    await expect(zoomToLocation("Bergen")).resolves.toBe(true);

    expect(flights[0]).toMatchObject({ longitude: 6.08, latitude: 51.59 });
  });

  // One row, not five: nobody sees the other four on this path.
  it("asks for a single candidate", async () => {
    geocode.mockResolvedValue([result()]);

    await zoomToLocation("Venlo");

    expect(geocode).toHaveBeenCalledWith("Venlo", 1);
  });

  it("reports failure when nothing is found", async () => {
    geocode.mockResolvedValue([]);

    await expect(zoomToLocation("Atlantis")).resolves.toBe(false);
    expect(flights).toHaveLength(0);
  });

  /**
   * `geocode` promises never to reject; this holds it to that, so a future
   * change there cannot turn a failed search into an unhandled rejection inside
   * a tool call.
   */
  it("does not swallow a broken geocoder contract silently", async () => {
    geocode.mockResolvedValue([]);

    await expect(zoomToLocation("Venlo")).resolves.toBe(false);
  });
});

describe("flyToResult", () => {
  /**
   * Framing is the reason both paths share this function. Asserted against
   * `viewForBbox` rather than hardcoded numbers so the heuristic stays free to
   * change without a test pinning it to today's arithmetic.
   */
  it("frames the extent when the candidate has one", async () => {
    const bbox = [5.8, 51.2, 6.3, 51.6] as const;
    geocodeExtent.mockResolvedValue(bbox);

    await flyToResult(result());

    const expected = viewForBbox([...bbox] as [number, number, number, number]);
    expect(flights[0]).toEqual({
      longitude: expected.center[0],
      latitude: expected.center[1],
      zoom: expected.zoom,
    });
  });

  /**
   * A point-like hit gets a fixed close zoom, because there is no extent to
   * derive one from.
   *
   * This used to pass `undefined` and claim the map "keeps its current zoom".
   * It does not: the flyto listener substitutes 12, so a house number was shown
   * at roughly 24 km across — the whole town it sits in.
   */
  it("flies to an address close enough to see the building", async () => {
    geocodeExtent.mockResolvedValue(undefined);

    await flyToResult(result({ kind: "adres", center: [6.16, 51.36] }));

    expect(flights[0]).toEqual({ longitude: 6.16, latitude: 51.36, zoom: 17 });
  });

  /**
   * One level wider than a house number: a Dutch six-digit postcode covers a
   * street segment of ~20-40 addresses, so framing it like one building
   * overshoots what the user asked for.
   */
  it("frames a postcode slightly wider than an address", async () => {
    geocodeExtent.mockResolvedValue(undefined);

    await flyToResult(result({ kind: "postcode", center: [6.16, 51.36] }));

    expect(flights[0]?.zoom).toBe(16);
  });

  /**
   * The safety the `kind` lookup depends on: PDOK adding a type nobody has seen
   * must degrade to slightly-wrong framing, never to no zoom at all — which is
   * what put a house number at town scale in the first place.
   */
  it("still picks a close zoom for a kind it does not recognise", async () => {
    geocodeExtent.mockResolvedValue(undefined);

    await flyToResult(result({ kind: "perceel", center: [6.16, 51.36] }));

    expect(flights[0]?.zoom).toBe(16);
  });

  /**
   * A street HAS an extent — PDOK sends a MULTILINESTRING — so it must be framed
   * from that box, not handed a point zoom. Measured from the real geometry for
   * Prinsessesingel, Venlo, which the old code framed at 12.
   */
  it("frames a street from its own extent, not a point zoom", async () => {
    const street = [6.164, 51.36739, 6.16678, 51.36939] as const;
    geocodeExtent.mockResolvedValue(street);

    await flyToResult(result({ kind: "weg" }));

    const expected = viewForBbox([...street] as [number, number, number, number]);
    expect(flights[0]?.zoom).toBe(expected.zoom);
    // The specific complaint: a street used to land at 12, a whole town wide.
    expect(flights[0]?.zoom).toBeGreaterThanOrEqual(14);
  });
});
