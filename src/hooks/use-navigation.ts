import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import {
  filterLayerConfig,
  getFilterLayerById,
  isFilterLayerId,
} from "@/layers/filter-layers";
import { forSide, type MapSide, type MapSideId, type MapSidePair } from "@/lib/map-side";
import type { LeafPair } from "@/layers/navigation";
import type { LayerPairsApi } from "@/hooks/use-layer-pairs";

interface UseNavigationOptions extends MapSidePair<MapSide> {
  /**
   * Where applied pairs are recorded, so the legend can keep them together.
   * Optional: without it a pair still applies, it just is not tracked
   * afterwards — which is what the hook's own tests exercise.
   */
  pairs?: LayerPairsApi;
}

/**
 * Resolve a navigation leaf id to its LayerConfig.
 *
 * Combination layers ("Criteria combineren") are created in the session and have no
 * `layers.json` entry, so they are rebuilt from the filter store instead. Their
 * ids are checked FIRST and without loading layers.json: the id space is
 * disjoint (`filter__*`), and toggling one off and on again must not depend on a
 * file that will never describe it — which is the bug this fixes.
 */
async function resolveConfig(
  id: string,
  getConfigs: () => Promise<LayerConfig[]>,
): Promise<LayerConfig | undefined> {
  if (isFilterLayerId(id)) {
    const def = getFilterLayerById(id);
    return def ? filterLayerConfig(def) : undefined;
  }
  return getLayerConfigById(await getConfigs(), id);
}

/**
 * Bridges the navigation menu to the existing per-map layer state. Resolves a
 * navigation leaf id to its LayerConfig and toggles it on/off a given map using
 * the same addLayer/removeLayer functions the URL commands and Legend use, so
 * all three share one source of truth.
 */
export function useNavigation(options: UseNavigationOptions) {
  // No local mirror of the configs: `loadLayerConfigs` memoizes per config
  // variant, so calling it each time is free and — unlike a private cache here
  // — always answers for the variant that is active *now*. A mirror would keep
  // handing out the previous variant's configs after a switch, toggling layers
  // that no longer exist onto the map.
  const getConfigs = () => loadLayerConfigs();

  function isOnMap(id: string, slot: MapSideId): boolean {
    const entries = forSide(options, slot).layers.layerEntries();
    return entries.some((e) => e.config.id === id);
  }

  async function toggleOnMap(id: string, slot: MapSideId) {
    const side = forSide(options, slot).layers;

    if (isOnMap(id, slot)) {
      side.removeLayer(id);
      return;
    }

    const config = await resolveConfig(id, getConfigs);
    if (!config) {
      console.warn(
        isFilterLayerId(id)
          ? `Combination layer "${id}" is no longer defined`
          : `Layer "${id}" not found in layers.json`,
      );
      return;
    }
    await side.addLayer(config);
  }

  // The right map can only receive layers once the left map has at least one:
  // comparison is left-anchored, so an empty left map has nothing to compare against.
  const leftHasLayers = () => options.left.layers.layerEntries().length > 0;

  /**
   * How much of a prepared comparison is currently applied.
   *
   * Three states rather than a boolean because a pair can be half on: the user
   * may remove one of the two layers from the legend, and the navigation row
   * has to offer something sensible when they do.
   */
  function pairState(pair: LeafPair): "none" | "partial" | "both" {
    const left = isOnMap(pair.left, "left");
    const right = isOnMap(pair.right, "right");
    if (left && right) return "both";
    return left || right ? "partial" : "none";
  }

  /**
   * Apply a prepared comparison, or clear it when any of it is already applied.
   *
   * The two adds are sequential and awaited, not concurrent. `toggleOnMap`
   * resolves a config before adding, and the right map refuses layers while the
   * left one is empty (see `leftHasLayers`) -- so firing both at once lets the
   * right add observe the left map as it was BEFORE its layer landed, and half
   * the pair is silently dropped.
   */
  async function togglePair(pair: LeafPair) {
    if (pairState(pair) === "none") {
      await toggleOnMap(pair.left, "left");
      await toggleOnMap(pair.right, "right");
      // Recorded only once both halves actually landed. A pair that half-failed
      // (a missing layers.json entry, say) is not a comparison, and recording
      // it would tie the surviving layer to a partner that never existed.
      if (pairState(pair) === "both") options.pairs?.add(pair);
      return;
    }

    // Partial or both: clear whichever halves are actually on. Checked
    // individually so a half-applied pair recovers to empty rather than
    // toggling its missing half back on.
    options.pairs?.forget(pair);
    if (isOnMap(pair.left, "left")) await toggleOnMap(pair.left, "left");
    if (isOnMap(pair.right, "right")) await toggleOnMap(pair.right, "right");
  }

  return { isOnMap, toggleOnMap, leftHasLayers, pairState, togglePair };
}

export type NavigationApi = ReturnType<typeof useNavigation>;
