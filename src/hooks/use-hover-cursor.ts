import { useCallback, useEffect, useMemo } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildNativeLayerDefs, expandForMapQueries, isNativeVectorFormat } from "@/layers";

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
  //
  // react-hooks/immutability flags writing through a ref owned by another
  // component. That is the intent: MapViewHandle deliberately exposes these
  // refs as an imperative channel to deck's render loop, which reads them at
  // 60fps and must never trigger a React re-render. The write happens in an
  // effect (not during render), so it is safe — just not expressible in the
  // ownership model the rule enforces.
  useEffect(() => {
    const ref = mapViewRef.current?.clickableIdsRef;
    // eslint-disable-next-line react-hooks/immutability
    if (ref) ref.current = clickableEntries.map((e) => e.ownerId);
  }, [clickableEntries, mapViewRef]);

  const handleMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const mvtHoverRef = mapViewRef.current?.mvtHoverRef;
      if (!mvtHoverRef) return;

      const map = mapViewRef.current?.mapRef?.current?.getMap();
      if (!map) {
        // Same imperative channel as above; written from an event handler.
        // eslint-disable-next-line react-hooks/immutability
        mvtHoverRef.current = false;
        return;
      }

      const mvtLayerIds: string[] = [];
      for (const entry of clickableEntries) {
        if (!isNativeVectorFormat(entry.config.format)) continue;
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
