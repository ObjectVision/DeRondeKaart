import type { UseMapLayersResult } from "@/hooks/use-map-layers";

/**
 * Which of the two maps something refers to.
 *
 * The app shows one map, or two side by side for comparison. Every feature that
 * can address a specific one — navigation, share links, annotations, host
 * commands — needs a way to say which, and this is it.
 *
 * Not to be confused with the WIRE values `"a"` and `"b"`, which share URLs and
 * host `map-command` messages carry. Those are a published format that existing
 * links depend on; {@link sideFromWire} and {@link sideToWire} convert at that
 * boundary and nothing else in the app should spell them.
 */
export type MapSideId = "left" | "right";

/** Both sides in a fixed order, for iterating without spelling them out. */
export const MAP_SIDES: readonly MapSideId[] = ["left", "right"];

/** One map's layer stack. */
export interface MapSide {
  layers: UseMapLayersResult;
}

/** A value for each side, when a caller holds both. */
export interface MapSidePair<T> {
  left: T;
  right: T;
}

/** Pick one side's value out of a pair. */
export function forSide<T>(pair: MapSidePair<T>, side: MapSideId): T {
  return side === "right" ? pair.right : pair.left;
}

/** Wire spelling of a side, as share URLs and host commands carry it. */
export type MapSideWire = "a" | "b";

/**
 * Read a wire value. Anything unrecognised — including a missing one — reads as
 * the left map, which is the sole map when comparison is off and so the only
 * safe default for a command that failed to say.
 */
export function sideFromWire(value: string | null | undefined): MapSideId {
  return value?.toLowerCase() === "b" ? "right" : "left";
}

/** Write a wire value. */
export function sideToWire(side: MapSideId): MapSideWire {
  return side === "right" ? "b" : "a";
}
