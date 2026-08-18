import { createEffect, type Accessor } from "solid-js";
import type { AddLayerObject } from "maplibre-gl";
import type { MapViewHandle } from "@/components/map/map-view-config";
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
 *
 * `resync` fires from a map event, outside any reactive scope, and simply reads
 * `box()` — the React version needed a ref mirroring it for exactly this.
 */
export function useSelectionBoxLayers(
  box: Accessor<BBox | null>,
  mapView: Accessor<MapViewHandle | null>,
): { resync: () => void } {
  function draw(current: BBox | null) {
    const map = mapView()?.map();
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
  }

  createEffect(() => draw(box()));

  return { resync: () => draw(box()) };
}
