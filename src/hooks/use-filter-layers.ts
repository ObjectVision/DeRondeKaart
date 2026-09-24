import { createSignal, type Accessor } from "solid-js";

import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import { filterRasterForStep, type GeoStylerFilter, type LayerConfig } from "@/layers";
import {
  addFilterLayer,
  addFilterLayerWithId,
  combinationSources,
  defaultScoreClasses,
  dependentsOf,
  filterLayerConfig,
  getFilterLayerById,
  getFilterLayers,
  isFilterLayerId,
  layerCountOf,
  removeFilterLayer,
  updateFilterLayer,
  type FilterLayerDef,
  type ScoreClass,
} from "@/layers/filter-layers";
import { computeScoreGrid, type ScoreInput } from "@/layers/filter-raster";
import { getScoreGrid, registerScoreGrid, unregisterScoreGrid } from "@/layers/score-protocol";
import type { NavLeaf } from "@/layers/navigation";

export interface UseFilterLayersResult {
  /** Combinations created this session, in creation order. */
  defs: Accessor<FilterLayerDef[]>;
  /** Navigation leaves for the "Combinaties" theme. */
  leaves: Accessor<NavLeaf[]>;
  /** True while a score grid is being read and combined. */
  busy: Accessor<boolean>;
  /** Last failure, in Dutch, for surfacing to the user. */
  error: Accessor<string | null>;
  /**
   * What an edit changed in the combinations built on it, in Dutch — a dropped
   * criterion, a reset legend. Null when the last edit touched nothing else.
   */
  notice: Accessor<string | null>;
  /** Clear both `error` and `notice`, once the user has read them. */
  dismissMessages: () => void;
  /** Build a combination from the dialog's selection and add it to the map. */
  create: (
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    /** Legend classes from the dialog's preview; omit for the default ramp. */
    classes?: ScoreClass[],
  ) => Promise<void>;
  /**
   * Replace an existing combination's criteria, legend and name, keeping its id,
   * recompute its score grid — and then every combination built on it, so they
   * follow the edit.
   *
   * `configs` must cover the catalogue layers of those dependents too, not only
   * the edited combination's: they are rescored from their own sources.
   *
   * Does NOT touch the map: a combination may sit on either side, or be toggled
   * off, so the caller re-adds each where it is. Returns every definition whose
   * grid changed, the edited one first; undefined when the edit itself failed
   * (the error is set), leaving the old combination exactly as it was.
   */
  update: (
    id: string,
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    classes: ScoreClass[],
  ) => Promise<FilterLayerDef[] | undefined>;
  /** Remove a combination from the map and release its grid. */
  remove: (id: string) => void;
  /**
   * Rebuild combinations that arrived in a share link's `combi` param.
   *
   * Registers each definition and recomputes its score grid, but does NOT put
   * it on the map — the link's own `cmd=add` commands do that, right after.
   *
   * Returns incoming id -> the id actually used, which the caller applies to
   * those pending commands: an incoming id already taken by a combination the
   * recipient built gets remapped rather than overwriting theirs. A definition
   * whose source layers are missing is left out of the map entirely.
   */
  restore: (
    defs: FilterLayerDef[],
    configs: LayerConfig[],
  ) => Promise<Map<string, string>>;
}

/**
 * One {@link ScoreInput} per LAYER, its chosen classes OR-ed together.
 *
 * Within a layer the classes are alternatives (a cell holds exactly one);
 * between layers they are requirements. Each layer therefore contributes at
 * most 1 to the score. Rule filters are reused verbatim, so a combination tests
 * exactly the predicate the vector layer draws with.
 *
 * Shared by `create`, `update` and `restore` so a combination rebuilt from a
 * share link scores through identical code — they differ only in where
 * `stepFor` comes from: the live legend, or the stored definition.
 *
 * A combination used as a criterion reads its registered score grid, and its
 * classes become `["==", "band0", score]` straight from `ref.score` — no rule
 * lookup by name, since its labels can be renamed. `configs` is not consulted
 * for it: combinations are never in the catalogue.
 */
function scoreInputsFor(
  refs: ClassRef[],
  configs: LayerConfig[],
  stepFor: (layerId: string) => number | undefined,
): ScoreInput[] {
  const inputs: ScoreInput[] = [];
  for (const layerId of new Set(refs.map((ref) => ref.layerId))) {
    if (isFilterLayerId(layerId)) {
      const grid = getScoreGrid(layerId);
      const filters = refs
        .filter((ref) => ref.layerId === layerId && ref.score !== undefined)
        .map((ref) => ["==", "band0", ref.score!] as GeoStylerFilter);
      if (!grid || filters.length === 0) continue;
      inputs.push({ grid, filter: orFilters(filters) });
      continue;
    }

    const config = configs.find((c) => c.id === layerId);
    // A timeseries layer templates the step into its raster URL, so the grid
    // matches the year the legend showed when combine was clicked.
    const rasterUrl = config ? filterRasterForStep(config, stepFor(layerId)) : undefined;
    if (!config || !rasterUrl) continue;

    const filters = refs
      .filter((ref) => ref.layerId === layerId)
      .map((ref) => config.geostyler?.rules.find((r) => r.name === ref.ruleName)?.filter)
      .filter((filter): filter is GeoStylerFilter => Boolean(filter));
    if (filters.length === 0) continue;

    inputs.push({ url: rasterUrl, filter: orFilters(filters) });
  }
  return inputs;
}

/** A lone class needs no wrapper; `["||", …]` only for a real choice. */
function orFilters(filters: GeoStylerFilter[]): GeoStylerFilter {
  return filters.length === 1 ? filters[0] : (["||", ...filters] as GeoStylerFilter);
}

/**
 * A dependent's refs after its source combinations changed: a class of a
 * source whose score no longer exists — the source lost a criterion, so its top
 * scores are gone — is dropped. Refs to catalogue layers are untouched.
 */
function refsStillValid(refs: ClassRef[]): ClassRef[] {
  return refs.filter((ref) => {
    if (ref.score === undefined) return true;
    const source = getFilterLayerById(ref.layerId);
    return source !== undefined && ref.score <= source.classes.length;
  });
}

/**
 * The timeseries step of each source layer that has one.
 *
 * Stored, not just templated into the URL: a share link rebuilds the grid from
 * the definition, and without them it would score whichever year the
 * recipient's session sits on. Shared by `create` and `update`.
 */
function stepsFor(
  refs: ClassRef[],
  stepFor: (layerId: string) => number | undefined,
): Record<string, number> {
  const steps: Record<string, number> = {};
  for (const layerId of new Set(refs.map((ref) => ref.layerId))) {
    const step = stepFor(layerId);
    if (step !== undefined) steps[layerId] = step;
  }
  return steps;
}

/**
 * Session-scoped combination layers: pick classes across layers, score each grid
 * cell by how many of them it passes, and put the result on the map.
 *
 * Mirrors `use-area-filter.ts` — the store lives in `filter-layers.ts` and this
 * hook holds only the reactive state over it.
 */
export function useFilterLayers(
  addLayer: (config: LayerConfig) => Promise<void>,
  removeLayer: (layerId: string) => void,
): UseFilterLayersResult {
  const [defs, setDefs] = createSignal<FilterLayerDef[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  async function create(
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    classes?: ScoreClass[],
  ) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const inputs = scoreInputsFor(refs, configs, stepFor);

      if (inputs.length === 0) {
        setError("Geen van de gekozen lagen heeft een bijbehorend raster.");
        return;
      }

      const { def } = addFilterLayer(name, refs, classes, stepsFor(refs, stepFor));
      const grid = await computeScoreGrid(inputs);
      registerScoreGrid(
        def.id,
        grid,
        def.classes.map((item) => item.color),
      );

      await addLayer(filterLayerConfig(def));
      setDefs(getFilterLayers());
    } catch (err) {
      // Surfaced in the UI rather than only logged: a failed combination
      // otherwise looks like a layer that silently never appears.
      console.error("Kon de gecombineerde laag niet maken", err);
      setError("Kon de gecombineerde laag niet maken.");
    } finally {
      setBusy(false);
    }
  }

  async function update(
    id: string,
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    classes: ScoreClass[],
  ): Promise<FilterLayerDef[] | undefined> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const inputs = scoreInputsFor(refs, configs, stepFor);
      if (inputs.length === 0) {
        setError("Geen van de gekozen lagen heeft een bijbehorend raster.");
        return undefined;
      }

      // The grid first, the store after: a failed computation then leaves the
      // old combination — definition and grid both — as it was.
      const grid = await computeScoreGrid(inputs);
      const def = updateFilterLayer(id, { name, refs, classes, steps: stepsFor(refs, stepFor) });
      if (!def) return undefined;

      // Replaces the grid registered under this id.
      registerScoreGrid(
        def.id,
        grid,
        def.classes.map((item) => item.color),
      );

      const { changed, notices } = await cascade(id, configs);
      if (notices.length > 0) setNotice(notices.join(" "));
      setDefs(getFilterLayers());
      return [def, ...changed];
    } catch (err) {
      console.error("Kon de gecombineerde laag niet aanpassen", err);
      setError("Kon de gecombineerde laag niet aanpassen.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Recompute every combination built on `id`, sources before dependents, so
   * each reads the grid its sources were just given.
   *
   * A dependent whose referenced score vanished (its source lost a criterion)
   * drops that class. If that removes a whole criterion, its score range shrinks
   * and its legend no longer fits, so the legend is reset to the defaults — the
   * same thing the dialog does when criteria change. A dependent left with
   * nothing to score keeps its old grid. Each case is reported in `notices`.
   *
   * One dependent failing does not stop the others: they are independent
   * grids, and the edit that triggered this has already been stored.
   */
  async function cascade(
    id: string,
    configs: LayerConfig[],
  ): Promise<{ changed: FilterLayerDef[]; notices: string[] }> {
    const changed: FilterLayerDef[] = [];
    const notices: string[] = [];

    for (const dependent of dependentsOf(id)) {
      try {
        const refs = refsStillValid(dependent.refs);
        const stepFor = (layerId: string) => dependent.steps?.[layerId];
        const inputs = scoreInputsFor(refs, configs, stepFor);
        if (inputs.length === 0) {
          notices.push(`"${dependent.name}" kon niet worden bijgewerkt: er blijft geen criterium over.`);
          continue;
        }

        const grid = await computeScoreGrid(inputs);
        let current = dependent;
        if (refs.length !== dependent.refs.length) {
          const criterionLost = layerCountOf(refs) !== layerCountOf(dependent.refs);
          current =
            updateFilterLayer(dependent.id, {
              name: dependent.name,
              refs,
              classes: criterionLost ? defaultScoreClasses(refs) : dependent.classes,
              steps: stepsFor(refs, stepFor),
            }) ?? dependent;
          notices.push(
            criterionLost
              ? `"${dependent.name}": een criterium is vervallen; de legenda is teruggezet.`
              : `"${dependent.name}": niet meer bestaande klassen zijn verwijderd.`,
          );
        }

        registerScoreGrid(
          current.id,
          grid,
          current.classes.map((item) => item.color),
        );
        changed.push(current);
      } catch (err) {
        console.error(`Kon "${dependent.name}" niet bijwerken`, err);
        notices.push(`"${dependent.name}" kon niet worden bijgewerkt.`);
      }
    }
    return { changed, notices };
  }

  function remove(id: string) {
    removeLayer(id);
    removeFilterLayer(id);
    unregisterScoreGrid(id);
    setDefs(getFilterLayers());
  }

  async function restore(
    incoming: FilterLayerDef[],
    configs: LayerConfig[],
  ): Promise<Map<string, string>> {
    const remapped = new Map<string, string>();
    setError(null);
    setBusy(true);
    try {
      for (const received of incoming) {
        // A combination used as a criterion resolves ONLY through this link's
        // own remap: its source arrived earlier in the same param (the sender
        // writes sources first). An unmapped `filter__*` id must not fall
        // through to whatever combination the recipient happens to hold under
        // that id — that would score against someone else's criteria.
        const unresolved = combinationSources(received).some((id) => !remapped.has(id));
        if (unresolved) {
          console.warn(
            `Combination "${received.name}" (${received.id}): a source combination is missing, skipped`,
          );
          continue;
        }
        const def: FilterLayerDef = {
          ...received,
          refs: received.refs.map((ref) =>
            isFilterLayerId(ref.layerId) ? { ...ref, layerId: remapped.get(ref.layerId)! } : ref,
          ),
        };

        // Same input builder as `create`, so a rebuilt combination scores
        // through identical code — steps come from the definition rather than
        // from this session's legend.
        const inputs = scoreInputsFor(def.refs, configs, (id) => def.steps?.[id]);
        if (inputs.length === 0) {
          // Its source layers are absent here — a different variant, or a
          // project that never had them. Leaving the id out of the remap lets
          // the link's own `add` warn, which is the existing failure mode for
          // an unresolvable layer rather than a new one.
          console.warn(`Combination "${def.name}" (${def.id}): no source raster, skipped`);
          continue;
        }

        const stored = addFilterLayerWithId(def);
        remapped.set(def.id, stored.id);

        const grid = await computeScoreGrid(inputs);
        registerScoreGrid(
          stored.id,
          grid,
          stored.classes.map((item) => item.color),
        );
      }
      setDefs(getFilterLayers());
    } catch (err) {
      console.error("Kon de gedeelde combinatielagen niet herstellen", err);
      setError("Kon de gedeelde combinatielagen niet herstellen.");
    } finally {
      setBusy(false);
    }
    return remapped;
  }

  const leaves = () =>
    defs().map((def) => ({
      id: def.id,
      label: def.name,
      color: def.classes[def.classes.length - 1].color,
    }));

  function dismissMessages() {
    setError(null);
    setNotice(null);
  }

  return { defs, leaves, busy, error, notice, dismissMessages, create, update, remove, restore };
}
