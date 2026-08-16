import { useCallback, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import type { GeoStylerRule, LayerConfig } from "@/layers";
import {
  addFilterLayer,
  getFilterLayers,
  removeFilterLayer,
  type FilterLayerDef,
} from "@/layers/filter-layers";
import { computeScoreGrid, type ScoreInput } from "@/layers/filter-raster";
import {
  registerScoreGrid,
  scoreSourceUrl,
  unregisterScoreGrid,
} from "@/layers/score-protocol";
import type { NavLeaf } from "@/layers/navigation";

type MapRefObject = React.RefObject<MapRef | null>;

export interface UseFilterLayersResult {
  /** Combinations created this session, in creation order. */
  defs: FilterLayerDef[];
  /** Navigation leaves for the "Combinaties" theme. */
  leaves: NavLeaf[];
  /** True while a score grid is being read and combined. */
  busy: boolean;
  /** Last failure, in Dutch, for surfacing to the user. */
  error: string | null;
  /** Build a combination from the dialog's selection and add it to the map. */
  create: (
    name: string,
    refs: ClassRef[],
    configs: LayerConfig[],
    mapRefs: MapRefObject[],
  ) => Promise<void>;
  /** Remove a combination from the maps and release its grid. */
  remove: (id: string, mapRefs: MapRefObject[]) => void;
}

/**
 * Dutch label for a combination's score class: with 3 filters, score 2 reads
 * "2 van 3 kenmerken".
 */
function scoreLabel(score: number, total: number): string {
  return `${score} van ${total} kenmerken`;
}

/**
 * Turn a definition into a `format: "cog"` LayerConfig backed by the in-memory
 * score grid.
 *
 * Deliberately an ordinary COG config: the score layer then travels the existing
 * `addCogLayer` path and inherits restacking, opacity, hide/show and the legend
 * without a single branch for combinations. `embeddedColors` is true because the
 * protocol already paints the score colours, so the rules serve as the legend
 * key rather than driving a colour function.
 */
function configFor(def: FilterLayerDef): LayerConfig {
  const rules: GeoStylerRule[] = def.colors.map((color, index) => {
    const score = index + 1;
    return {
      name: scoreLabel(score, def.refs.length),
      filter: ["==", "band0", score],
      symbolizers: [{ kind: "Fill", color }],
    };
  });

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
 * Session-scoped combination layers: pick classes across layers, score each grid
 * cell by how many of them it passes, and put the result on the map.
 *
 * Mirrors `use-area-filter.ts` — the store lives in `filter-layers.ts` and this
 * hook holds only the React-facing state.
 */
export function useFilterLayers(
  addLayer: (config: LayerConfig, mapRef: MapRefObject) => Promise<void>,
  removeLayer: (layerId: string, mapRef: MapRefObject) => void,
): UseFilterLayersResult {
  const [defs, setDefs] = useState<FilterLayerDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (
      name: string,
      refs: ClassRef[],
      configs: LayerConfig[],
      mapRefs: MapRefObject[],
    ) => {
      setError(null);
      setBusy(true);
      try {
        // Resolve each chosen class to its layer's companion raster and the
        // rule's own filter, so the combination reuses the exact predicate the
        // vector layer draws with.
        const inputs: ScoreInput[] = [];
        for (const ref of refs) {
          const config = configs.find((c) => c.id === ref.layerId);
          if (!config?.filterRaster) continue;
          const rule = config.geostyler?.rules.find((r) => r.name === ref.ruleName);
          if (!rule?.filter) continue;
          inputs.push({ url: config.filterRaster, filter: rule.filter });
        }

        if (inputs.length === 0) {
          setError("Geen van de gekozen lagen heeft een bijbehorend raster.");
          return;
        }

        const { def } = addFilterLayer(name, refs);
        const grid = await computeScoreGrid(inputs);
        registerScoreGrid(def.id, grid, def.colors);

        const config = configFor(def);
        for (const mapRef of mapRefs) {
          await addLayer(config, mapRef);
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
    },
    [addLayer],
  );

  const remove = useCallback(
    (id: string, mapRefs: MapRefObject[]) => {
      for (const mapRef of mapRefs) {
        removeLayer(id, mapRef);
      }
      removeFilterLayer(id);
      unregisterScoreGrid(id);
      setDefs(getFilterLayers());
    },
    [removeLayer],
  );

  const leaves: NavLeaf[] = defs.map((def) => ({
    id: def.id,
    label: def.name,
    color: def.colors[def.colors.length - 1],
  }));

  return { defs, leaves, busy, error, create, remove };
}
