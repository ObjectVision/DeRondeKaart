import { describe, it, expect } from "vitest";
import {
  MAP_SIDES,
  forSide,
  sideFromWire,
  sideToWire,
  type MapSideId,
} from "@/lib/map-side";

/**
 * The wire values `"a"`/`"b"` are a published format: every share link already
 * out there carries them, and the Power BI host posts them in `map-command`.
 * Renaming the internal type must not reach the wire, so these pin both
 * directions.
 */
describe("map side wire format", () => {
  it("reads the wire spellings", () => {
    expect(sideFromWire("a")).toBe("left");
    expect(sideFromWire("b")).toBe("right");
  });

  it("writes the wire spellings", () => {
    expect(sideToWire("left")).toBe("a");
    expect(sideToWire("right")).toBe("b");
  });

  it("round-trips both sides", () => {
    for (const side of MAP_SIDES) {
      expect(sideFromWire(sideToWire(side))).toBe(side);
    }
  });

  it("accepts the uppercase a host might send", () => {
    expect(sideFromWire("B")).toBe("right");
    expect(sideFromWire("A")).toBe("left");
  });

  // A command that fails to name a map still has to go somewhere, and the left
  // map is the only one guaranteed to exist — the right is conditional.
  it("falls back to the left map for a missing or unknown value", () => {
    expect(sideFromWire(undefined)).toBe("left");
    expect(sideFromWire(null)).toBe("left");
    expect(sideFromWire("")).toBe("left");
    expect(sideFromWire("nonsense")).toBe("left");
  });
});

describe("map side pair", () => {
  it("picks each side's value", () => {
    const pair = { left: "L", right: "R" };
    expect(forSide(pair, "left")).toBe("L");
    expect(forSide(pair, "right")).toBe("R");
  });

  it("lists both sides once, left first", () => {
    expect([...MAP_SIDES]).toEqual<MapSideId[]>(["left", "right"]);
  });
});
