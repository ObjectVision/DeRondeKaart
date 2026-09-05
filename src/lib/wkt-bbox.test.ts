import { describe, expect, it } from "vitest";

import { parseWktPoint, wktBbox } from "@/lib/wkt-bbox";

/**
 * The WKT reader behind the PDOK geocoder.
 *
 * Two things here are easy to get silently wrong and are pinned deliberately:
 * the coordinate ORDER (WKT writes lon before lat, and a swap puts the
 * Netherlands in Somalia), and the fact that an envelope must span EVERY ring of
 * a MULTIPOLYGON rather than stopping at the first.
 */

describe("parseWktPoint", () => {
  it("reads lon first, then lat", () => {
    // PDOK's centroid for Gemeente Venlo — 6°E 51°N, not the other way round.
    expect(parseWktPoint("POINT(6.15911182 51.39095482)")).toEqual([6.15911182, 51.39095482]);
  });

  it("tolerates a space before the paren and any casing", () => {
    expect(parseWktPoint("Point (5.5 52.5)")).toEqual([5.5, 52.5]);
  });

  it("reads negative coordinates", () => {
    expect(parseWktPoint("POINT(-4.25 -21.5)")).toEqual([-4.25, -21.5]);
  });

  /**
   * A polygon's first vertex is an arbitrary corner, not its location. Returning
   * it would be a wrong answer that looks plausible, so the mix-up must surface.
   */
  it("refuses a polygon rather than reading its first vertex", () => {
    expect(parseWktPoint("POLYGON((6 51,7 51,7 52,6 51))")).toBeNull();
  });

  it.each([["POINT(x y)"], [""], ["POINT()"], ["not wkt at all"]])(
    "returns null for the malformed input %j",
    (input) => {
      expect(parseWktPoint(input)).toBeNull();
    },
  );

  it.each([[undefined], [null], [42], [{}]])(
    "returns null rather than throwing for the non-string %j",
    (input) => {
      expect(parseWktPoint(input)).toBeNull();
    },
  );
});

describe("wktBbox", () => {
  it("returns the envelope of a simple polygon", () => {
    expect(wktBbox("POLYGON((6 51,7 51,7 52,6 52,6 51))")).toEqual([6, 51, 7, 52]);
  });

  /**
   * The case a reader that stopped at the first ring would get wrong: a gemeente
   * with an exclave spans both parts, and framing only the first would cut the
   * other off the map.
   */
  it("unions every part of a MULTIPOLYGON", () => {
    const wkt = "MULTIPOLYGON(((6 51,7 51,7 52,6 51)),((10 55,11 55,11 56,10 55)))";

    expect(wktBbox(wkt)).toEqual([6, 51, 11, 56]);
  });

  /**
   * Documents why ring structure is ignored: an interior ring lies inside its
   * exterior, so sweeping every coordinate gives the same envelope as walking
   * the nesting would.
   */
  it("is unaffected by an interior ring", () => {
    const withHole = "POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,3 2,3 3,2 3,2 2))";

    expect(wktBbox(withHole)).toEqual([0, 0, 10, 10]);
  });

  it("refuses a point, which has no extent to frame", () => {
    expect(wktBbox("POINT(6.15 51.39)")).toBeNull();
  });

  it("returns null for a single-coordinate degenerate polygon", () => {
    expect(wktBbox("POLYGON((6 51))")).toBeNull();
  });

  it.each([[undefined], [null], [""], ["MULTIPOLYGON"], [7]])(
    "returns null rather than throwing for %j",
    (input) => {
      expect(wktBbox(input)).toBeNull();
    },
  );
});
