import { useCallback, useMemo, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
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
  mapLeftRef: React.RefObject<MapViewHandle | null>;
  mapRightRef: React.RefObject<MapViewHandle | null>;
}

const emptyRef: React.RefObject<MapRef | null> = { current: null };

/**
 * Resolve a navigation leaf id to its LayerConfig.
 *
 * Combination layers ("Lagen combineren") are created in the session and have no
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
export function useNavigation({
  mapLeftLayers,
  mapRightLayers,
  mapLeftRef,
  mapRightRef,
}: UseNavigationOptions) {
  const configsRef = useRef<LayerConfig[] | null>(null);

  const getConfigs = useCallback(async () => {
    if (!configsRef.current) {
      configsRef.current = await loadLayerConfigs();
    }
    return configsRef.current;
  }, []);

  const isOnMap = useCallback(
    (id: string, slot: MapSlot): boolean => {
      const entries = slot === "b" ? mapRightLayers.layerEntries : mapLeftLayers.layerEntries;
      return entries.some((e) => e.config.id === id);
    },
    [mapLeftLayers.layerEntries, mapRightLayers.layerEntries],
  );

  const toggleOnMap = useCallback(
    async (id: string, slot: MapSlot) => {
      const side = slot === "b" ? mapRightLayers : mapLeftLayers;
      const ref = slot === "b" ? mapRightRef : mapLeftRef;
      const mapRef = ref.current?.mapRef ?? emptyRef;

      if (isOnMap(id, slot)) {
        side.removeLayer(id, mapRef);
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
      await side.addLayer(config, mapRef);
    },
    [mapLeftLayers, mapRightLayers, mapLeftRef, mapRightRef, isOnMap, getConfigs],
  );

  // The right map can only receive layers once the left map has at least one:
  // comparison is left-anchored, so an empty left map has nothing to compare against.
  const leftHasLayers = mapLeftLayers.layerEntries.length > 0;

  return useMemo(
    () => ({ isOnMap, toggleOnMap, leftHasLayers }),
    [isOnMap, toggleOnMap, leftHasLayers],
  );
}

export type NavigationApi = ReturnType<typeof useNavigation>;
