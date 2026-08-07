import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AddLayerObject } from "maplibre-gl";
import type { MapViewHandle } from "@/components/map/MapView";
import type { BBox } from "@/layers/box-filter";
import {
  EMPTY_FC,
  featureCollection,
  styleReady,
  syncGeoJsonOverlay,
} from "@/layers/geojson-overlay";

const SOURCE_ID = "selection-box";
const FILL_ID = "selection-box-fill";
const LINE_ID = "selection-box-line";

/** Brand blue #00498D: faint tint inside, solid 2px outline. */
const LAYERS: AddLayerObject[] = [
  {
    id: FILL_ID,
    type: "fill",
    source: SOURCE_ID,
    paint: { "fill-color": "#00498D", "fill-opacity": 15 / 255 },
  },
  {
    id: LINE_ID,
    type: "line",
    source: SOURCE_ID,
    paint: { "line-color": "#00498D", "line-opacity": 220 / 255, "line-width": 2 },
  },
];

/**
 * Draw the area-select rectangle as a MapLibre GeoJSON overlay, pinned above
 * everything else. `box` of `null` clears it.
 *
 * Returns a `resync` to re-add the layers after a basemap swap (`setStyle()`
 * wipes them); call it from the map's `onLabelsReady`.
 */
export function useSelectionBoxLayers(
  box: BBox | null,
  mapViewRef: React.RefObject<MapViewHandle | null>,
): { resync: () => void } {
  // The latest box, read by `resync` — which fires from a map event, long
  // after the render that produced it. Written in an effect, never in render.
  const boxRef = useRef<BBox | null>(box);

  const draw = useCallback(
    (current: BBox | null) => {
      const map = mapViewRef.current?.mapRef.current?.getMap();
      if (!styleReady(map)) return;

      if (!current) {
        syncGeoJsonOverlay(map, SOURCE_ID, LAYERS, EMPTY_FC);
        return;
      }

      const [minLng, minLat, maxLng, maxLat] = current;
      syncGeoJsonOverlay(
        map,
        SOURCE_ID,
        LAYERS,
        featureCollection({
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [minLng, minLat],
                [maxLng, minLat],
                [maxLng, maxLat],
                [minLng, maxLat],
                [minLng, minLat],
              ],
            ],
          },
        }),
      );
    },
    [mapViewRef],
  );

  useEffect(() => {
    boxRef.current = box;
    draw(box);
  }, [box, draw]);

  const resync = useCallback(() => draw(boxRef.current), [draw]);
  return useMemo(() => ({ resync }), [resync]);
}
