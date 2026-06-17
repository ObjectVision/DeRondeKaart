import { useCallback, useMemo, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { useMapLayers } from "./use-map-layers";

type MapSlot = "a" | "b";

interface UseNavigationOptions {
  mapALayers: ReturnType<typeof useMapLayers>;
  mapBLayers: ReturnType<typeof useMapLayers>;
  mapARef: React.RefObject<MapViewHandle | null>;
  mapBRef: React.RefObject<MapViewHandle | null>;
}

const emptyRef: React.RefObject<MapRef | null> = { current: null };

/**
 * Bridges the navigation menu to the existing per-map layer state. Resolves a
 * navigation leaf id to its LayerConfig and toggles it on/off a given map using
 * the same addLayer/removeLayer functions the URL commands and Legend use, so
 * all three share one source of truth.
 */
export function useNavigation({
  mapALayers,
  mapBLayers,
  mapARef,
  mapBRef,
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
      const entries = slot === "b" ? mapBLayers.layerEntries : mapALayers.layerEntries;
      return entries.some((e) => e.config.id === id);
    },
    [mapALayers.layerEntries, mapBLayers.layerEntries],
  );

  const toggleOnMap = useCallback(
    async (id: string, slot: MapSlot) => {
      const side = slot === "b" ? mapBLayers : mapALayers;
      const ref = slot === "b" ? mapBRef : mapARef;
      const mapRef = ref.current?.mapRef ?? emptyRef;

      if (isOnMap(id, slot)) {
        side.removeLayer(id, mapRef);
        return;
      }

      const configs = await getConfigs();
      const config = getLayerConfigById(configs, id);
      if (!config) {
        console.warn(`Layer "${id}" not found in layers.json`);
        return;
      }
      await side.addLayer(config, mapRef);
    },
    [mapALayers, mapBLayers, mapARef, mapBRef, isOnMap, getConfigs],
  );

  return useMemo(() => ({ isOnMap, toggleOnMap }), [isOnMap, toggleOnMap]);
}

export type NavigationApi = ReturnType<typeof useNavigation>;
