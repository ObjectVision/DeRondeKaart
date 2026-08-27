import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";

import { useLayerPairs } from "@/hooks/use-layer-pairs";
import type { MapSideId } from "@/lib/map-side";

/**
 * Which layers a fake pair of maps is holding. The hook asks this to decide
 * whether a recorded pair is still real.
 */
function maps(left: string[], right: string[]) {
  const onMap = (id: string, side: MapSideId) =>
    (side === "left" ? left : right).includes(id);
  return { onMap, left, right };
}

/** Run a hook outside a component, disposing after the body. */
function withPairs<T>(
  isOnMap: (id: string, side: MapSideId) => boolean,
  body: (api: ReturnType<typeof useLayerPairs>) => T,
): T {
  return createRoot((dispose) => {
    const api = useLayerPairs(isOnMap);
    try {
      return body(api);
    } finally {
      dispose();
    }
  });
}

describe("useLayerPairs", () => {
  it("resolves a recorded pair from either half", () => {
    const m = maps(["357"], ["357_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("357", "left")).toEqual({ left: "357", right: "357_2026" });
      expect(pairs.pairFor("357_2026", "right")).toEqual({
        left: "357",
        right: "357_2026",
      });
      expect(pairs.isPaired("357", "left")).toBe(true);
    });
  });

  /**
   * The side is part of the key, not decoration. Nothing in the config format
   * stops a pair's two halves sharing an id, and matching on id alone would
   * then resolve the wrong half and remove a layer the user still wants.
   */
  it("does not resolve a left id from the right side", () => {
    const m = maps(["357"], ["357_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("357", "right")).toBeNull();
      expect(pairs.pairFor("357_2026", "left")).toBeNull();
    });
  });

  it("knows nothing about a layer that was never paired", () => {
    const m = maps(["357", "solo"], ["357_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("solo", "left")).toBeNull();
      expect(pairs.isPaired("solo", "left")).toBe(false);
    });
  });

  /**
   * Self-healing. A half can leave by a path that never tells this hook — a URL
   * command, a dashboard slot. What remains is a single layer, and treating it
   * as half a pair would take an unrelated layer down with it.
   */
  it("treats a pair whose other half already left as no pair at all", () => {
    // The right half is gone from the right map.
    const m = maps(["357"], []);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("357", "left")).toBeNull();
      expect(pairs.isPaired("357", "left")).toBe(false);
    });
  });

  it("forgets a pair", () => {
    const m = maps(["357"], ["357_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });
      pairs.forget({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("357", "left")).toBeNull();
      expect(pairs.pairs()).toHaveLength(0);
    });
  });

  it("clears every pair, for a variant switch", () => {
    const m = maps(["357", "207"], ["357_2026", "207_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });
      pairs.add({ left: "207", right: "207_2026" });
      pairs.clear();

      expect(pairs.pairs()).toHaveLength(0);
    });
  });

  // Re-applying the same pair must not stack duplicates that later have to be
  // forgotten one at a time.
  it("records a repeated pair only once", () => {
    const m = maps(["357"], ["357_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });
      pairs.add({ left: "357", right: "357_2026" });

      expect(pairs.pairs()).toHaveLength(1);
    });
  });

  it("keeps unrelated pairs apart", () => {
    const m = maps(["357", "207"], ["357_2026", "207_2026"]);

    withPairs(m.onMap, (pairs) => {
      pairs.add({ left: "357", right: "357_2026" });
      pairs.add({ left: "207", right: "207_2026" });

      pairs.forget({ left: "357", right: "357_2026" });

      expect(pairs.pairFor("357", "left")).toBeNull();
      expect(pairs.pairFor("207", "left")).toEqual({ left: "207", right: "207_2026" });
    });
  });
});
