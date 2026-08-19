import { createEffect, onCleanup, type Accessor } from "solid-js";

import type { MapViewHandle } from "@/components/map/map-view-config";
import type { LayerConfig } from "@/layers";
import { canHighlight } from "@/layers";
import {
  NO_COMPARE_SLOT,
  clearCompareSelections,
  compareSelections,
  isCompareSelectable,
  removeCompareSelection,
  toggleCompareSelection,
  type CompareSelection,
} from "@/layers/compare-slots";
import { tileSourceId } from "@/hooks/use-map-layers";

/** What `setFeatureState` needs to address one feature. */
interface FeatureKey {
  source: string;
  sourceLayer: string | undefined;
  id: string | number;
}

export interface UseCompareSelectionResult {
  /**
   * Add or remove the clicked feature; a fifth rolls the oldest out. False only
   * when the layer never offered itself for comparison.
   */
  toggle: (config: LayerConfig, featureId: string | number, code: string, label: string) => boolean;
  /** Drop one selection by slot. */
  remove: (slot: number) => void;
  /** Drop them all. */
  clear: () => void;
}

/**
 * Drives the `compareSlot` feature state behind the dashboard's area
 * comparison — the multi-feature sibling of `use-feature-highlight.ts`.
 *
 * Separate from that hook because the shape differs: hover and click each hold
 * one feature, this holds up to four at once and paints them in different
 * colours from one numeric state (see buildCompareLayerDefs).
 *
 * The two rules that hook documents apply here unchanged:
 * - **Clear by writing `NO_COMPARE_SLOT`, never `removeFeatureState`.** MapLibre
 *   6.3.0 throws from the latter once the state has been flushed to a tile, and
 *   the map then stops painting entirely.
 * - **Forget the held keys on `styledata`**, because a basemap swap drops every
 *   source together with its feature state.
 */
export function useCompareSelection(
  mapView: Accessor<MapViewHandle | null>,
  configById: (layerId: string) => LayerConfig | undefined,
): UseCompareSelectionResult {
  // Keys of the features currently carrying a slot, so they can be cleared
  // without re-deriving them from configs that may since have left the map.
  // Not a signal: nothing renders from it and the panel reads the store.
  let active: Array<{ key: FeatureKey; slot: number }> = [];

  function keyFor(config: LayerConfig, featureId: string | number): FeatureKey {
    return {
      source: tileSourceId(config),
      // Read at call time: a timeseries layer rewrites `sourceLayer` in place.
      sourceLayer: config.sourceLayer,
      id: featureId,
    };
  }

  /** Push the store's state onto the map, clearing whatever it replaces. */
  function sync(selections: CompareSelection[]) {
    const map = mapView()?.map();
    if (!map) {
      active = [];
      return;
    }

    for (const entry of active) {
      if (map.getSource(entry.key.source)) {
        map.setFeatureState(entry.key, { compareSlot: NO_COMPARE_SLOT });
      }
    }

    const next: Array<{ key: FeatureKey; slot: number }> = [];
    for (const selection of selections) {
      const config = configById(selection.layerId);
      if (!config || !canHighlight(config)) continue;
      const key = keyFor(config, selection.featureId);
      if (!map.getSource(key.source)) continue;
      map.setFeatureState(key, { compareSlot: selection.slot });
      next.push({ key, slot: selection.slot });
    }
    active = next;
  }

  function toggle(
    config: LayerConfig,
    featureId: string | number,
    code: string,
    label: string,
  ): boolean {
    if (!isCompareSelectable(config)) return false;
    sync(toggleCompareSelection({ featureId, layerId: config.id, code, label }));
    return true;
  }

  function remove(slot: number) {
    sync(removeCompareSelection(slot));
  }

  function clear() {
    clearCompareSelections();
    sync([]);
  }

  // Re-apply after a style change: setStyle drops the sources and with them the
  // feature state, so the outlines would silently disappear while the panel
  // still lists the areas. Reading the store here also re-applies when a
  // selection is made before the map finished loading.
  createEffect(() => {
    const map = mapView()?.map();
    if (!map) return;
    const selections = compareSelections();

    function resync() {
      active = [];
      sync(selections);
    }

    map.on("styledata", resync);
    onCleanup(() => map.off("styledata", resync));
    sync(selections);
  });

  return { toggle, remove, clear };
}
