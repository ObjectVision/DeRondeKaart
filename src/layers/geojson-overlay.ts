import type { Map as MapLibreMap, AddLayerObject } from "maplibre-gl";
import type { Feature, FeatureCollection, Geometry } from "geojson";

/**
 * Imperative GeoJSON overlays: the "always on top" chrome (click marker,
 * selection box, gebiedsfilter mask, annotations) that used to ride deck.gl's
 * `topLayers` channel.
 *
 * Two things differ from deck and drive the shape of this module:
 *
 * 1. Deck kept its layers in React state and re-resolved them itself. A
 *    MapLibre source/layer lives on the map's style, so a basemap `setStyle()`
 *    WIPES it — every caller needs a resync from `onLabelsReady`. Making both
 *    `ensure` and `setData` idempotent is what lets that resync be a plain
 *    re-invocation rather than a teardown/rebuild.
 * 2. Deck matched layers by id and diffed props. Here, updating means pushing
 *    new data into an existing source, so the layer specs are created once and
 *    only `setData` runs on the hot path (a drag emits one per throttled move).
 */

/** An empty collection — the "nothing to draw" state for every overlay. */
export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

export function featureCollection(
  features: Feature<Geometry>[] | Feature<Geometry>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Array.isArray(features) ? features : [features],
  };
}

/**
 * Whether the map is ready for `addSource`/`addLayer`.
 *
 * Deliberately NOT `isStyleLoaded()`: that also waits for sources and sprites,
 * while `addSource` only needs the style JSON itself (`style._loaded`). The
 * stricter check would skip the initial add on a map that mounts with overlay
 * data already pending, leaving it blank until the next resync.
 */
export function styleReady(map: MapLibreMap | null | undefined): map is MapLibreMap {
  if (!map || !map.style) return false;
  return Boolean((map.style as unknown as { _loaded?: boolean })._loaded);
}

/**
 * Add a GeoJSON source and its layers if they aren't on the style yet, then
 * push `data` into the source. Safe to call on every render and after a
 * basemap swap — existing sources/layers are left alone and only re-fed.
 *
 * Layers are appended with no `beforeId` (topmost) unless one is given. The
 * anchor layers are the z-order mechanism for banded content; overlay chrome
 * deliberately sits above all of them.
 */
export function syncGeoJsonOverlay(
  map: MapLibreMap,
  sourceId: string,
  layers: AddLayerObject[],
  data: FeatureCollection,
  beforeId?: string,
): void {
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: "geojson", data });
    for (const layer of layers) {
      if (map.getLayer(layer.id)) continue;
      // addLayer throws on a beforeId that isn't in the style — fall back to
      // appending, matching the guard the native config-layer path uses.
      map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    }
    return;
  }

  // The source survived but a layer may not have (or was added later).
  for (const layer of layers) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
  }

  const source = map.getSource(sourceId);
  if (source && "setData" in source) {
    (source as { setData: (d: FeatureCollection) => void }).setData(data);
  }
}

/** Remove an overlay's layers and source. Idempotent. */
export function removeGeoJsonOverlay(
  map: MapLibreMap,
  sourceId: string,
  layerIds: string[],
): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}
