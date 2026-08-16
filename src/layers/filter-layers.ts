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
 * Blue-to-red ramp for scores. Score 1 (weakest match) is the coolest colour and
 * the top score the warmest, so "passes everything" reads as the strongest
 * signal on the map.
 */
const SCORE_RAMP = ["#B3CDE3", "#6497B1", "#3E74A7", "#C1548A", "#B5104A"];

/**
 * Colours for a combination of `count` filters — `count` steps spread across the
 * ramp, so two filters use its ends rather than its first two entries.
 */
export function rampFor(count: number): string[] {
  if (count <= 1) return [SCORE_RAMP[SCORE_RAMP.length - 1]];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push(SCORE_RAMP[Math.round(t * (SCORE_RAMP.length - 1))]);
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
