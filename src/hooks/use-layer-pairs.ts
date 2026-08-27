import { createSignal, type Accessor } from "solid-js";
import type { MapSideId } from "@/lib/map-side";

/** Two layer ids applied together as one comparison: left map, right map. */
export interface AppliedPair {
  left: string;
  right: string;
}

/**
 * Which layers currently on the maps were applied together as a pair.
 *
 * A paired navigation leaf puts one layer on each map so the two can be
 * compared. Once they land, nothing in the layer stacks records that they
 * belong together — `LayerEntry` is just a config — so the legend would happily
 * let a user remove one half or move it across, leaving a "comparison" of one
 * layer against nothing. This is the missing link, held for the session.
 *
 * Deliberately NOT re-derived from navigation.json on demand: the same ids also
 * appear as a pair in the tree when a user adds them individually as singles,
 * and re-deriving would couple layers they never asked to pair.
 *
 * `isOnMap` is injected rather than imported so the state can be self-healing:
 * a half removed by some path that never tells this hook (a URL command, a
 * dashboard slot) leaves a pair that is no longer real, and every lookup here
 * checks both halves are still present before answering.
 */
export function useLayerPairs(isOnMap: (id: string, side: MapSideId) => boolean) {
  const [pairs, setPairs] = createSignal<AppliedPair[]>([]);

  const samePair = (a: AppliedPair, b: AppliedPair) =>
    a.left === b.left && a.right === b.right;

  /** Record a pair as applied. Idempotent — re-applying must not duplicate it. */
  function add(pair: AppliedPair): void {
    setPairs((prev) =>
      prev.some((p) => samePair(p, pair)) ? prev : [...prev, pair],
    );
  }

  /** Drop a pair, whether or not it is still on the maps. */
  function forget(pair: AppliedPair): void {
    setPairs((prev) => prev.filter((p) => !samePair(p, pair)));
  }

  /** Drop every pair — for a variant switch, which empties both maps. */
  function clear(): void {
    setPairs([]);
  }

  /**
   * The pair `id` belongs to on `side`, or null.
   *
   * The side is required, not a convenience: a pair's two halves can share an
   * id (nothing in the config format forbids it), and matching on id alone
   * would then resolve the wrong half. `"left"` matches only `pair.left`.
   *
   * Returns null for a pair whose other half has already left its map — that
   * pair is no longer a comparison, so treating it as one would remove a layer
   * the user is still using.
   */
  function pairFor(id: string, side: MapSideId): AppliedPair | null {
    const match = pairs().find((p) => (side === "left" ? p.left : p.right) === id);
    if (!match) return null;
    const intact = isOnMap(match.left, "left") && isOnMap(match.right, "right");
    return intact ? match : null;
  }

  /** Whether this layer is half of an intact pair, and so cannot move or leave alone. */
  function isPaired(id: string, side: MapSideId): boolean {
    return pairFor(id, side) !== null;
  }

  return { pairs: pairs as Accessor<AppliedPair[]>, add, forget, clear, pairFor, isPaired };
}

export type LayerPairsApi = ReturnType<typeof useLayerPairs>;
