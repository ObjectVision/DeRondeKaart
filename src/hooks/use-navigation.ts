import type { Accessor } from "solid-js";
import type { MapAccessor, MapViewHandle } from "@/components/map/map-view-config";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import {
  filterLayerConfig,
  getFilterLayerById,
  isFilterLayerId,
} from "@/layers/filter-layers";
import type { useMapLayers } from "./use-map-layers";

type MapSlot = "a" | "b";

interface UseNavigationOptions {
  mapLeftLayers: ReturnType<typeof useMapLayers>;
  mapRightLayers: ReturnType<typeof useMapLayers>;
  mapLeft: Accessor<MapViewHandle | null>;
  mapRight: Accessor<MapViewHandle | null>;
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

  function isOnMap(id: string, slot: MapSlot): boolean {
    const entries =
      slot === "b"
        ? options.mapRightLayers.layerEntries()
        : options.mapLeftLayers.layerEntries();
    return entries.some((e) => e.config.id === id);
  }

  async function toggleOnMap(id: string, slot: MapSlot) {
    const side = slot === "b" ? options.mapRightLayers : options.mapLeftLayers;
    const handle = slot === "b" ? options.mapRight : options.mapLeft;
    // Resolved lazily and null-tolerant: map B is conditionally mounted, and
    // the layer helpers treat a null map as "not there yet".
    const getMap: MapAccessor = () => handle()?.map() ?? null;

    if (isOnMap(id, slot)) {
      side.removeLayer(id, getMap);
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
    await side.addLayer(config, getMap);
  }

  // The right map can only receive layers once the left map has at least one:
  // comparison is left-anchored, so an empty left map has nothing to compare against.
  const leftHasLayers = () => options.mapLeftLayers.layerEntries().length > 0;

  return { isOnMap, toggleOnMap, leftHasLayers };
}

export type NavigationApi = ReturnType<typeof useNavigation>;
