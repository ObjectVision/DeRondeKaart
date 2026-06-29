import { useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildMvtLayerDefs } from "@/layers";

/**
 * Hover hit-test that drives the map cursor: `pointer` when the mouse is over a
 * clickable feature (a layer with `featureinfo` configured and not excluded from
 * picking), `grab` otherwise. Reuses the same picking sources and filter as
 * `useFeaturePick` so the cursor is a truthful "this is clickable" affordance.
 *
 * The result is written to `MapViewHandle.hoverRef`, which the deck.gl overlay's
 * `getCursor` reads live. We drive the cursor through deck (which owns the canvas
 * cursor in interleaved mode) rather than react-map-gl's `cursor` prop, because
 * MapLibre continuously rewrites `canvas.style.cursor` during pointer interaction
 * and would clobber a value set only on prop change.
 */
export function useHoverCursor(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
) {
  const handleMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const hoverRef = mapViewRef.current?.hoverRef;
      if (!hoverRef) return;

      // Same set of clickable layers as use-feature-pick.ts
      const infoEntries = layerEntries.filter(
        (e) =>
          e.config.featureinfo &&
          e.config.format !== "cog" &&
          !e.config.excludeFromPicking,
      );

      if (infoEntries.length === 0) {
        hoverRef.current = false;
        return;
      }

      let hit = false;

      // --- deck.gl hit-test (GeoArrow/Parquet) ---
      const overlay = mapViewRef.current?.overlayRef?.current;
      if (overlay) {
        const info = (overlay as any).pickObject({
          x: event.point.x,
          y: event.point.y,
          radius: 2,
        });
        if (info?.object && info?.layer) {
          const deckLayerId: string = info.layer.id;
          hit = infoEntries.some(
            (e) =>
              (e.config.format === "geoarrow" ||
                e.config.format === "parquet" ||
                e.config.format === "geoparquet") &&
              deckLayerId.startsWith(e.config.id),
          );
        }
      }

      // --- MapLibre hit-test (MVT) ---
      if (!hit) {
        const map = mapViewRef.current?.mapRef?.current?.getMap();
        if (map) {
          const mvtEntries = infoEntries.filter((e) => e.config.format === "mvt");
          const mvtLayerIds: string[] = [];
          for (const entry of mvtEntries) {
            for (const def of buildMvtLayerDefs(entry.config)) {
              if (map.getLayer(def.id)) mvtLayerIds.push(def.id);
            }
          }
          if (mvtLayerIds.length > 0) {
            const features = map.queryRenderedFeatures(event.point, {
              layers: mvtLayerIds,
            });
            hit = features.length > 0;
          }
        }
      }

      hoverRef.current = hit;
    },
    [layerEntries, mapViewRef],
  );

  return { handleMouseMove };
}
