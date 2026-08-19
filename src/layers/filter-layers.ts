import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import type { GeoStylerRule, LayerConfig } from "@/layers/types";
import { scoreSourceUrl } from "@/layers/score-protocol";

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
  /**
   * Legend classes over scores 1..layerCount, index 0 = score 1. Defaults come
   * from {@link defaultScoreClasses}; the combine dialog may hand over labels
   * and colours the user edited in its preview.
   */
  classes: ScoreClass[];
}

/** One legend class of a combination — the class for score `index + 1`. */
export interface ScoreClass {
  label: string;
  color: string;
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
 * criterion) is red and the top score blue, so the cells that satisfy everything
 * read as the calm end of the scale and the partial matches stand out as warm.
 *
 * Seven stops, sampled by {@link rampFor}. It is a diverging scheme, so it stays
 * legible at any step count and its midpoint (#ffffbf) is deliberately the
 * palest — a combination with an odd number of layers puts "half the criteria"
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

/**
 * Dutch label for a combination's score class: with 3 layers, score 2 reads
 * "2 van 3 criteria". `total` is the LAYER count — one layer is one criterion,
 * however many of its classes were ticked. The dialog uses the same word.
 */
function scoreLabel(score: number, total: number): string {
  return `${score} van ${total} criteria`;
}

/**
 * The legend a selection would produce untouched: the ramp colours paired with
 * the "x van y criteria" labels.
 *
 * Exported because the combine dialog previews the legend before the layer
 * exists, and the preview has to start from exactly what creation would use —
 * two independent defaults would drift apart.
 */
export function defaultScoreClasses(refs: ClassRef[]): ScoreClass[] {
  const total = layerCountOf(refs);
  // rampFor(0) still yields one colour; an empty selection has no legend at all.
  if (total === 0) return [];
  return rampFor(total).map((color, index) => ({
    label: scoreLabel(index + 1, total),
    color,
  }));
}

/**
 * Rebuild a combination's LayerConfig from its stored definition.
 *
 * Lives beside the store rather than in the hook because it is needed wherever a
 * `filter__*` id has to be resolved — the navigation tree re-adds a layer the
 * user toggled off, and `layers.json` has no entry for it. Deriving the config
 * from the definition each time keeps one description of what a combination
 * layer is; the underlying score grid stays registered with the protocol for the
 * session, so re-adding costs nothing.
 *
 * Deliberately an ordinary COG config: the score layer then travels the existing
 * `addCogLayer` path and inherits restacking, opacity, hide/show and the legend
 * without a single branch for combinations. `embeddedColors` is true because the
 * protocol already paints the score colours, so the rules serve as the legend
 * key rather than driving a colour function.
 */
export function filterLayerConfig(def: FilterLayerDef): LayerConfig {
  const rules: GeoStylerRule[] = def.classes.map((item, index) => ({
    name: item.label,
    filter: ["==", "band0", index + 1],
    symbolizers: [{ kind: "Fill", color: item.color }],
  }));

  return {
    id: def.id,
    name: def.name,
    source: scoreSourceUrl(def.id),
    format: "cog",
    embeddedColors: true,
    style: { opacity: 0.8 },
    geostyler: { name: def.name, rules },
    // Combination layers describe a derived score, not a surveyed dataset, so
    // there is nothing to click through to.
    excludeFromPicking: true,
  };
}

/**
 * Add a combination, returning the new definition and the store version.
 *
 * `classes` defaults to the untouched legend: one entry per attainable score,
 * i.e. per LAYER — not per ticked class.
 */
export function addFilterLayer(
  name: string,
  refs: ClassRef[],
  classes: ScoreClass[] = defaultScoreClasses(refs),
): { def: FilterLayerDef; version: number } {
  const def: FilterLayerDef = {
    id: `filter__${store.nextId}`,
    name,
    refs,
    classes,
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
