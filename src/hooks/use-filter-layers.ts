import { createSignal, type Accessor } from "solid-js";
import type { MapAccessor } from "@/components/map/map-view-config";

import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import { filterRasterForStep, type GeoStylerFilter, type LayerConfig } from "@/layers";
import {
  addFilterLayer,
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
    maps: MapAccessor[],
    stepFor: (layerId: string) => number | undefined,
    /** Legend classes from the dialog's preview; omit for the default ramp. */
    classes?: ScoreClass[],
  ) => Promise<void>;
  /** Remove a combination from the maps and release its grid. */
  remove: (id: string, maps: MapAccessor[]) => void;
}

/**
 * Session-scoped combination layers: pick classes across layers, score each grid
 * cell by how many of them it passes, and put the result on the map.
 *
 * Mirrors `use-area-filter.ts` — the store lives in `filter-layers.ts` and this
 * hook holds only the reactive state over it.
 */
export function useFilterLayers(
  addLayer: (config: LayerConfig, map: MapAccessor) => Promise<void>,
  removeLayer: (layerId: string, map: MapAccessor) => void,
): UseFilterLayersResult {
  const [defs, setDefs] = createSignal<FilterLayerDef[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function create(
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    maps: MapAccessor[],
    stepFor: (layerId: string) => number | undefined,
    classes?: ScoreClass[],
  ) {
    setError(null);
    setBusy(true);
    try {
      // One input per LAYER, its chosen classes OR-ed together: within a layer
      // the classes are alternatives (a cell holds exactly one), between
      // layers they are requirements. Each layer therefore contributes at most
      // 1 to the score. Rule filters are reused verbatim, so the combination
      // tests exactly the predicate the vector layer draws with.
      const inputs: ScoreInput[] = [];
      for (const layerId of new Set(refs.map((ref) => ref.layerId))) {
        const config = configs.find((c) => c.id === layerId);
        // A timeseries layer templates the step into its raster URL, so the
        // grid matches the year the legend showed when combine was clicked.
        const rasterUrl = config ? filterRasterForStep(config, stepFor(layerId)) : undefined;
        if (!config || !rasterUrl) continue;

        const filters = refs
          .filter((ref) => ref.layerId === layerId)
          .map((ref) => config.geostyler?.rules.find((r) => r.name === ref.ruleName)?.filter)
          .filter((filter): filter is GeoStylerFilter => Boolean(filter));
        if (filters.length === 0) continue;

        // A lone class needs no wrapper; `["||", …]` only for a real choice.
        const filter =
          filters.length === 1 ? filters[0] : (["||", ...filters] as GeoStylerFilter);
        inputs.push({ url: rasterUrl, filter });
      }

      if (inputs.length === 0) {
        setError("Geen van de gekozen lagen heeft een bijbehorend raster.");
        return;
      }

      const { def } = addFilterLayer(name, refs, classes);
      const grid = await computeScoreGrid(inputs);
      registerScoreGrid(
        def.id,
        grid,
        def.classes.map((item) => item.color),
      );

      const config = filterLayerConfig(def);
      for (const map of maps) {
        await addLayer(config, map);
      }
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

  function remove(id: string, maps: MapAccessor[]) {
    for (const map of maps) {
      removeLayer(id, map);
    }
    removeFilterLayer(id);
    unregisterScoreGrid(id);
    setDefs(getFilterLayers());
  }

  const leaves = () =>
    defs().map((def) => ({
      id: def.id,
      label: def.name,
      color: def.classes[def.classes.length - 1].color,
    }));

  return { defs, leaves, busy, error, create, remove };
}
