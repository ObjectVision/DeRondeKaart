import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildMvtLayerDefs } from "@/layers";

/**
 * Given a click, return the lng/lat to drop the marker at. When the click hits a
 * **point** feature, snap to that feature's location so the marker sits on the
 * point rather than the raw cursor pixel; otherwise return null (the caller falls
 * back to the cursor's `lngLat`).
 *
 * Robust/simple variant: uses deck's picked `info.coordinate` (the geo location
 * on the hit point) for GeoArrow/Parquet, and the feature geometry for MVT — no
 * geometry-column decoding. Accurate to within the rendered dot's radius.
 */
export function resolveMarkerPoint(
  event: MapLayerMouseEvent,
  mapViewRef: React.RefObject<MapViewHandle | null>,
  layerEntries: LayerEntry[],
): { lng: number; lat: number } | null {
  const pointEntries = layerEntries.filter(
    (e) => e.config.geometryType === "point" && e.config.format !== "cog",
  );
  if (pointEntries.length === 0) return null;

  // --- deck.gl point layers (GeoArrow/Parquet) ---
  const overlay = mapViewRef.current?.overlayRef?.current;
  if (overlay) {
    const info = (overlay as any).pickObject({
      x: event.point.x,
      y: event.point.y,
      radius: 4,
    });
    const deckLayerId: string | undefined = info?.layer?.id;
    if (info?.object && deckLayerId) {
      const entry = pointEntries.find(
        (e) =>
          (e.config.format === "geoarrow" ||
            e.config.format === "parquet" ||
            e.config.format === "geoparquet") &&
          deckLayerId.startsWith(e.config.id),
      );
      if (entry && Array.isArray(info.coordinate) && info.coordinate.length >= 2) {
        return { lng: info.coordinate[0], lat: info.coordinate[1] };
      }
    }
  }

  // --- MVT point layers ---
  const map = mapViewRef.current?.mapRef?.current?.getMap();
  if (map) {
    const mvtLayerIds: string[] = [];
    for (const entry of pointEntries) {
      if (entry.config.format !== "mvt") continue;
      for (const def of buildMvtLayerDefs(entry.config)) {
        if (map.getLayer(def.id)) mvtLayerIds.push(def.id);
      }
    }
    if (mvtLayerIds.length > 0) {
      const features = map.queryRenderedFeatures(event.point, { layers: mvtLayerIds });
      const geom = features[0]?.geometry;
      if (geom?.type === "Point" && Array.isArray(geom.coordinates)) {
        return { lng: geom.coordinates[0], lat: geom.coordinates[1] };
      }
    }
  }

  return null;
}
