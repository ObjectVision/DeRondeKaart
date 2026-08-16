import type { ClassRef } from "@/components/ui/CombineLayersDialog";

/** A user-created combination of classes across layers. */
export interface FilterLayerDef {
  /**
   * Layer id. The `filter__` prefix avoids the `__b` / `__c` separators that
   * composite children and band suffixes already claim.
   */
  id: string;
  /** Dutch, auto-generated from the selection, editable by the user. */
  name: string;
  /**
   * The chosen classes. Several may belong to one layer: within a layer they are
   * OR-ed, and a cell's score counts the LAYERS matched — see
   * {@link layerCountOf}, which is the top of the score range, not `refs.length`.
   */
  refs: ClassRef[];
  /** Ramp over scores 1..layerCount, index 0 = score 1. */
  colors: string[];
}

/**
 * How many distinct layers a selection spans — the maximum attainable score.
 *
 * Not `refs.length`: ticking two classes of one layer widens that layer's match
 * but cannot make a cell satisfy it twice, since a cell holds exactly one class
 * per layer. Using the ref count would label the legend "van 3" for a two-layer
 * combination whose top score is 2, leaving a class that can never be reached.
 */
export function layerCountOf(refs: ClassRef[]): number {
  return new Set(refs.map((ref) => ref.layerId)).size;
}

/**
 * Module store of the combinations created this session, mirroring
 * `area-filter.ts`: a module-level object with a monotonic `version` that
 * mutators bump and return, so React state can be re-derived without the store
 * knowing about React.
 *
 * Session-scoped by design. Share URLs and annotation snapshots resolve layer
 * ids through `getLayerConfigById` and silently drop unknown ones, so a filter
 * layer simply does not come back — documented rather than half-fixed.
 */
const store: { version: number; defs: FilterLayerDef[]; nextId: number } = {
  version: 0,
  defs: [],
  nextId: 1,
};

/**
 * Spectral ramp for scores, red through yellow to blue: score 1 (matching one
 * kenmerk) is red and the top score blue, so the cells that satisfy everything
 * read as the calm end of the scale and the partial matches stand out as warm.
 *
 * Seven stops, sampled by {@link rampFor}. It is a diverging scheme, so it stays
 * legible at any step count and its midpoint (#ffffbf) is deliberately the
 * palest — a combination with an odd number of layers puts "half the kenmerken"
 * there.
 */
const SCORE_RAMP = [
  "#d53e4f",
  "#fc8d59",
  "#fee08b",
  "#ffffbf",
  "#e6f598",
  "#99d594",
  "#3288bd",
];

/** Blend two "#rrggbb" colours; `t` runs 0 (a) to 1 (b). */
function mixHex(a: string, b: string, t: number): string {
  const channel = (offset: number) => {
    const from = parseInt(a.slice(offset, offset + 2), 16);
    const to = parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * t)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * Colours for a combination of `count` layers — `count` steps spread across the
 * ramp, so two layers take its ends (red, blue) rather than its first two stops.
 *
 * Interpolates between stops rather than snapping to the nearest one: with more
 * layers than the ramp has stops, rounding would hand two different scores the
 * same colour and make them indistinguishable on the map. Counts up to the stop
 * count still land exactly on the authored colours.
 *
 * A single-layer combination gets the ramp's LAST colour: with nothing to
 * compare against, "matches" should read as the top of the scale rather than as
 * the weakest step.
 */
export function rampFor(count: number): string[] {
  if (count <= 1) return [SCORE_RAMP[SCORE_RAMP.length - 1]];
  const out: string[] = [];
  const last = SCORE_RAMP.length - 1;
  for (let i = 0; i < count; i++) {
    const position = (i / (count - 1)) * last;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, last);
    out.push(mixHex(SCORE_RAMP[lower], SCORE_RAMP[upper], position - lower));
  }
  return out;
}

/** Add a combination, returning the new definition and the store version. */
export function addFilterLayer(
  name: string,
  refs: ClassRef[],
): { def: FilterLayerDef; version: number } {
  const def: FilterLayerDef = {
    id: `filter__${store.nextId}`,
    name,
    refs,
    // One colour per attainable score, i.e. per LAYER — not per ticked class.
    colors: rampFor(layerCountOf(refs)),
  };
  store.nextId += 1;
  store.defs = [...store.defs, def];
  store.version += 1;
  return { def, version: store.version };
}

/** Remove a combination by id. Returns the new store version. */
export function removeFilterLayer(id: string): number {
  store.defs = store.defs.filter((def) => def.id !== id);
  store.version += 1;
  return store.version;
}

export function getFilterLayers(): FilterLayerDef[] {
  return store.defs;
}

export function getFilterLayerById(id: string): FilterLayerDef | undefined {
  return store.defs.find((def) => def.id === id);
}

export function getFilterLayerVersion(): number {
  return store.version;
}

/** True for ids this store owns, so callers can branch without a lookup. */
export function isFilterLayerId(id: string): boolean {
  return id.startsWith("filter__");
}
