import { useCallback, useEffect, useMemo } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildNativeLayerDefs, expandForMapQueries } from "@/layers";

/**
 * Drives the map cursor to `pointer` over clickable features (layers with
 * `featureinfo` and not excluded from picking), `grab` otherwise.
 *
 * The cursor is applied via deck.gl's `getCursor` (deck owns the canvas cursor in
 * interleaved mode). Two sources feed it:
 *  - **deck layers (GeoArrow/Parquet):** deck's own `onHover` sets `hoverRef` from
 *    its existing picking pass — we publish the clickable config ids here so it can
 *    match. We deliberately avoid a synchronous `pickObject` per mousemove, which
 *    stalls the main thread and makes Chromium flash a blue "progress" cursor.
 *  - **MVT layers:** deck's picking doesn't cover native MapLibre layers, so we do a
 *    cheap `queryRenderedFeatures` on mousemove and set `mvtHoverRef`.
 */
export function useHoverCursor(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
) {
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

  // Publish clickable OWNER ids for deck's onHover to match picked layer ids
  // against (child deck-layer ids start with the parent id, so a prefix match
  // on the owner covers composite children too).
  useEffect(() => {
    const ref = mapViewRef.current?.clickableIdsRef;
    if (ref) ref.current = clickableEntries.map((e) => e.ownerId);
  }, [clickableEntries, mapViewRef]);

  const handleMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const mvtHoverRef = mapViewRef.current?.mvtHoverRef;
      if (!mvtHoverRef) return;

      const map = mapViewRef.current?.mapRef?.current?.getMap();
      if (!map) {
        mvtHoverRef.current = false;
        return;
      }

      const mvtLayerIds: string[] = [];
      for (const entry of clickableEntries) {
        if (entry.config.format !== "mvt" && entry.config.format !== "flatgeobuf") continue;
        for (const def of buildNativeLayerDefs(entry.config)) {
          if (map.getLayer(def.id)) mvtLayerIds.push(def.id);
        }
      }

      if (mvtLayerIds.length === 0) {
        mvtHoverRef.current = false;
        return;
      }

      const features = map.queryRenderedFeatures(event.point, {
        layers: mvtLayerIds,
      });
      mvtHoverRef.current = features.length > 0;
    },
    [clickableEntries, mapViewRef],
  );

  return { handleMouseMove };
}
