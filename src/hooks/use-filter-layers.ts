import { createSignal, type Accessor } from "solid-js";

import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import { filterRasterForStep, type GeoStylerFilter, type LayerConfig } from "@/layers";
import {
  addFilterLayer,
  addFilterLayerWithId,
  filterLayerConfig,
  getFilterLayers,
  removeFilterLayer,
  type FilterLayerDef,
  type ScoreClass,
} from "@/layers/filter-layers";
import { computeScoreGrid, type ScoreInput } from "@/layers/filter-raster";
import { registerScoreGrid, unregisterScoreGrid } from "@/layers/score-protocol";
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
  /** Build a combination from the dialog's selection and add it to the map. */
  create: (
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    /** Legend classes from the dialog's preview; omit for the default ramp. */
    classes?: ScoreClass[],
  ) => Promise<void>;
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
 * Shared by `create` and `restore` so a combination rebuilt from a share link
 * scores through identical code — they differ only in where `stepFor` comes
 * from: the live legend, or the stored definition.
 */
function scoreInputsFor(
  refs: ClassRef[],
  configs: LayerConfig[],
  stepFor: (layerId: string) => number | undefined,
): ScoreInput[] {
  const inputs: ScoreInput[] = [];
  for (const layerId of new Set(refs.map((ref) => ref.layerId))) {
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

    // A lone class needs no wrapper; `["||", …]` only for a real choice.
    const filter = filters.length === 1 ? filters[0] : (["||", ...filters] as GeoStylerFilter);
    inputs.push({ url: rasterUrl, filter });
  }
  return inputs;
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

  async function create(
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    stepFor: (layerId: string) => number | undefined,
    classes?: ScoreClass[],
  ) {
    setError(null);
    setBusy(true);
    try {
      const inputs = scoreInputsFor(refs, configs, stepFor);

      if (inputs.length === 0) {
        setError("Geen van de gekozen lagen heeft een bijbehorend raster.");
        return;
      }

      // The steps are stored, not just templated into the URL: a share link
      // rebuilds the grid from the definition, and without them it would score
      // whichever year the recipient's session sits on.
      const steps: Record<string, number> = {};
      for (const layerId of new Set(refs.map((ref) => ref.layerId))) {
        const step = stepFor(layerId);
        if (step !== undefined) steps[layerId] = step;
      }

      const { def } = addFilterLayer(name, refs, classes, steps);
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
      for (const def of incoming) {
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

  return { defs, leaves, busy, error, create, remove, restore };
}
