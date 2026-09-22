import { describe, expect, it } from "vitest";

import {
  encodeFilterLayerParam,
  parseFilterLayerParam,
} from "@/layers/filter-layer-url";
import type { FilterLayerDef } from "@/layers/filter-layers";

/**
 * Names and rule names are free text. The non-ASCII characters are the point:
 * `btoa` throws above U+00FF, so an ASCII-only fixture would pass while the
 * feature broke on the first pasted euro sign.
 */
const DEFS: FilterLayerDef[] = [
  {
    id: "filter__1",
    name: "Prijs > 3 €/m³ & isolatie 100% #top +/- ½ 🏠",
    refs: [
      { layerId: "aandeel_j0_17", ruleName: "0-10%" },
      { layerId: "aandeel_j0_17", ruleName: "10-15%" },
      { layerId: "supermarkt", ruleName: "goed / matig" },
    ],
    classes: [
      { label: "1 van 2 criteria", color: "#d53e4f" },
      { label: "2 van 2 criteria", color: "#3288bd" },
    ],
    steps: { aandeel_j0_17: 2040 },
  },
  {
    id: "filter__2",
    name: "Groen",
    refs: [{ layerId: "groen", ruleName: "hoog" }],
    classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
  },
];

function encoded(): string {
  return encodeFilterLayerParam(DEFS);
}

describe("encodeFilterLayerParam", () => {
  it("round-trips definitions verbatim, order included", () => {
    expect(parseFilterLayerParam(encoded())).toEqual(DEFS);
  });

  it("keeps the timeseries step, so a rebuild scores the same year", () => {
    const back = parseFilterLayerParam(encoded());
    expect(back?.[0].steps).toEqual({ aandeel_j0_17: 2040 });
    // Absent rather than an empty object on a combination without a timeseries.
    expect(back?.[1].steps).toBeUndefined();
  });

  it("emits base64url, so the URL needs no percent-encoding", () => {
    expect(encoded()).not.toMatch(/[+/=]/);
  });
});

describe("parseFilterLayerParam", () => {
  it.each([
    ["not base64 at all", "!!!not base64!!!"],
    ["base64 of something that is not JSON", btoa("hello there")],
    ["JSON that is not an array", btoa(JSON.stringify({ id: "filter__1" }))],
    ["an array of non-objects", btoa(JSON.stringify(["filter__1"]))],
  ])("rejects %s", (_label, raw) => {
    expect(parseFilterLayerParam(raw)).toBeNull();
  });

  it("rejects the whole param when one element is malformed", () => {
    // The second element has no refs. Restoring only the first would leave its
    // `cmd=add` resolving and the other warning — a map that looks complete.
    const raw = encodeFilterLayerParam([
      DEFS[0],
      { ...DEFS[1], refs: [] } as FilterLayerDef,
    ]);

    expect(parseFilterLayerParam(raw)).toBeNull();
  });

  it("rejects a step that is not a number", () => {
    const raw = encodeFilterLayerParam([
      { ...DEFS[0], steps: { aandeel_j0_17: "2040" } } as unknown as FilterLayerDef,
    ]);

    expect(parseFilterLayerParam(raw)).toBeNull();
  });
});
