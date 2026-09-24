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
  /**
   * Timeseries step per source layer, for the layers that have one.
   *
   * A combination is a snapshot of the years its legend showed, and only the
   * generated `name` carries a trace of that ("… (2040)", as text). Without
   * this a rebuild from a share link would score whichever step the recipient's
   * session happens to sit on — a wrong answer under the right name, with
   * nothing to error on.
   */
  steps?: Record<string, number>;
}

/**
 * The one scoring method, as the user reads it. Shared by the combine dialog,
 * which states it, and the generated metainfo, which repeats it — two copies
 * would drift the moment a second method is added.
 */
export const COMBINATION_STRATEGY = "Telling van voldane criteria zonder weging";

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
 * Session-scoped, but not unshareable: a share link carries each combination's
 * whole definition in its `combi` param and the recipient rebuilds the score
 * grid from it (`filter-layer-url.ts`, `useFilterLayers.restore`). A plain
 * reload without that link still loses them, and annotation snapshots still
 * resolve ids through `getLayerConfigById` and drop combinations.
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
  steps?: Record<string, number>,
): { def: FilterLayerDef; version: number } {
  const def: FilterLayerDef = {
    id: `filter__${store.nextId}`,
    name,
    refs,
    classes,
    ...(steps && Object.keys(steps).length > 0 ? { steps } : {}),
  };
  store.nextId += 1;
  store.defs = [...store.defs, def];
  store.version += 1;
  return { def, version: store.version };
}

/**
 * Adopt a definition that arrived from outside — a share link's `combi` param.
 *
 * Keeps the incoming id when it is free, so the link's `cmd=add&layer=filter__1`
 * finds it. When that id is already taken by a DIFFERENT combination the
 * recipient built this session, mints a fresh one instead of overwriting: the
 * link must not delete work the recipient did. The caller is told which id was
 * used and rewrites its pending commands accordingly.
 *
 * `nextId` is pushed past any adopted `filter__<n>`, or the next `create()` in
 * this session would mint an id that already exists.
 */
export function addFilterLayerWithId(incoming: FilterLayerDef): FilterLayerDef {
  const taken = store.defs.some((def) => def.id === incoming.id);
  const def: FilterLayerDef = taken
    ? { ...incoming, id: `filter__${store.nextId}` }
    : { ...incoming };

  if (taken) store.nextId += 1;
  else {
    const suffix = Number(def.id.slice("filter__".length));
    if (Number.isSafeInteger(suffix) && suffix >= store.nextId) store.nextId = suffix + 1;
  }

  store.defs = [...store.defs, def];
  store.version += 1;
  return def;
}

/**
 * Replace a combination's criteria, legend and name in place, keeping its id.
 *
 * In place rather than remove-and-add, so the id a share link or the map's layer
 * stack already holds keeps pointing at the edited combination. `steps` is
 * replaced whole, and an empty one is dropped as in {@link addFilterLayer}: an
 * edit that removes the last timeseries layer must not keep its stale year.
 *
 * Returns undefined when no combination has that id.
 */
export function updateFilterLayer(
  id: string,
  patch: Pick<FilterLayerDef, "name" | "refs" | "classes" | "steps">,
): FilterLayerDef | undefined {
  const current = store.defs.find((def) => def.id === id);
  if (!current) return undefined;

  const def: FilterLayerDef = {
    id,
    name: patch.name,
    refs: patch.refs,
    classes: patch.classes,
    ...(patch.steps && Object.keys(patch.steps).length > 0 ? { steps: patch.steps } : {}),
  };
  store.defs = store.defs.map((item) => (item.id === id ? def : item));
  store.version += 1;
  return def;
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

/** The combinations `def` uses as criteria — the `filter__*` ids in its refs. */
export function combinationSources(def: FilterLayerDef): string[] {
  return [...new Set(def.refs.map((ref) => ref.layerId).filter(isFilterLayerId))];
}

/**
 * Every stored combination built on `id`, directly or through another, in the
 * order they must be recomputed: a combination always after the ones it uses.
 *
 * Also what keeps the combine dialog cycle-free: editing `id`, none of these may
 * be offered as its criterion, since each already depends on it.
 */
export function dependentsOf(id: string): FilterLayerDef[] {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const def of store.defs) {
      if (found.has(def.id) || !combinationSources(def).includes(current)) continue;
      found.add(def.id);
      queue.push(def.id);
    }
  }
  return inDependencyOrder(store.defs.filter((def) => found.has(def.id)));
}

/**
 * `defs` plus every combination they use, transitively, sources first.
 *
 * For share links: a combination on the map cannot be rebuilt by the recipient
 * without its sources, even when those are no longer on the map themselves.
 * Sources not in the store are left out; the rebuild then skips the dependent.
 */
export function withSources(defs: FilterLayerDef[]): FilterLayerDef[] {
  const byId = new globalThis.Map<string, FilterLayerDef>();
  const visit = (def: FilterLayerDef) => {
    if (byId.has(def.id)) return;
    byId.set(def.id, def);
    for (const sourceId of combinationSources(def)) {
      const source = getFilterLayerById(sourceId);
      if (source) visit(source);
    }
  };
  defs.forEach(visit);
  return inDependencyOrder([...byId.values()]);
}

/**
 * Order combinations so each comes after the combinations it uses. Stable
 * otherwise: an unrelated pair keeps its incoming order. The graph is acyclic by
 * construction (see {@link dependentsOf}), but a cycle smuggled in by a crafted
 * link must not hang the loop, so leftovers are appended as they are.
 */
function inDependencyOrder(defs: FilterLayerDef[]): FilterLayerDef[] {
  const pending = new Set(defs.map((def) => def.id));
  const out: FilterLayerDef[] = [];
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const def of defs) {
      if (!pending.has(def.id)) continue;
      if (combinationSources(def).some((sourceId) => pending.has(sourceId))) continue;
      pending.delete(def.id);
      out.push(def);
      progressed = true;
    }
  }
  return [...out, ...defs.filter((def) => pending.has(def.id))];
}
