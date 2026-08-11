import { useCallback, useMemo } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildNativeLayerDefs, expandForMapQueries, isNativeVectorFormat } from "@/layers";
import { geojsonLayerIds } from "@/layers/geojson-layer";

/**
 * Drives the map cursor to `pointer` over clickable features (layers with
 * `featureinfo` and not excluded from picking).
 *
 * The cursor is written straight onto the canvas: a cheap
 * `queryRenderedFeatures` per mousemove decides, and clearing it back to `""`
 * (NOT "grab") hands control to MapLibre's own stylesheet, which is what draws
 * grab/grabbing during a drag-pan. Writing "grab" explicitly would freeze the
 * cursor and break `grabbing`.
 *
 * A crosshair while a draw tool is armed outranks this and is applied by App;
 * `drawModeRef` is checked here so a hover never overwrites it.
 */
export interface UseHoverCursorResult {
  handleMouseMove: (event: MapLayerMouseEvent) => void;
}

export function useHoverCursor(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
): UseHoverCursorResult {
  // Clickable set: same filter as use-feature-pick.ts. Composite entries are
  // expanded to their children (the configs actually on the map), with the
  // parent's featureinfo/excludeFromPicking deciding clickability.
  const clickableEntries = useMemo(
    () =>
      expandForMapQueries(layerEntries).filter(
        (e) =>
          e.featureinfo &&
          e.config.format !== "cog" &&
          !e.excludeFromPicking,
      ),
    [layerEntries],
  );

  const handleMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const handle = mapViewRef.current;
      const map = handle?.mapRef?.current?.getMap();
      if (!map) return;

      // An armed draw tool owns the cursor; don't fight it.
      if (handle?.drawModeRef.current) return;

      const canvas = map.getCanvas();
      const layerIds: string[] = [];
      for (const entry of clickableEntries) {
        if (isNativeVectorFormat(entry.config.format)) {
          for (const def of buildNativeLayerDefs(entry.config)) {
            if (map.getLayer(def.id)) layerIds.push(def.id);
          }
        } else if (entry.config.format === "geojson") {
          for (const id of geojsonLayerIds(entry.config)) {
            if (map.getLayer(id)) layerIds.push(id);
          }
        }
      }

      if (layerIds.length === 0) {
        canvas.style.cursor = "";
        return;
      }

      const features = map.queryRenderedFeatures(event.point, { layers: layerIds });
      canvas.style.cursor = features.length > 0 ? "pointer" : "";
    },
    [clickableEntries, mapViewRef],
  );

  return { handleMouseMove };
}
