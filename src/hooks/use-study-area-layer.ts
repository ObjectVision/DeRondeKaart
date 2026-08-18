import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { MapViewHandle } from "@/components/map/map-view-config";
import {
  loadLayerConfigs,
  getLayerConfigById,
  isNativeVectorFormat,
  buildNativeLayerDefs,
} from "@/layers";
import { addMvtLayer, tileSourceId } from "./use-map-layers";
import type { LayerConfig } from "@/layers";

/**
 * Load the configured "study area" layer as native MapLibre layers, always
 * active and pinned to the `studyarea-layers` anchor band.
 *
 * Loaded through its own channel (not `useMapLayers`) so it stays out of the
 * legend, feature-picking, and comparison logic — the config carries
 * `excludeFromLegend` / `excludeFromPicking` / `excludeFromComparison` to match.
 * Picking is opt-in (it needs `featureinfo` plus registration as a layer entry),
 * so these layers never swallow clicks meant for the data layers beneath.
 *
 * Returns a `resync` callback that re-adds the layers after a basemap swap:
 * `setStyle()` wipes every source and layer, and unlike the old deck.gl overlay
 * — which re-resolved its own interleaved layers — native layers have to be
 * rebuilt by hand. Call it from the map's `onLabelsReady`, which fires after
 * the anchors have been re-created.
 *
 * Passing `undefined` for `studyAreaId` REMOVES the layers. Callers rely on
 * this to hand the band over to the filtered study area while a gebiedsfilter
 * selection is active — with deck that was a matter of picking one array over
 * another, but native layers persist on the map until removed.
 */
export function useStudyAreaLayer(
  studyAreaId: Accessor<string | undefined>,
  mapView: Accessor<MapViewHandle | null>,
): { resync: () => void } {
  // The resolved config, kept for `resync` (which must not re-fetch) and for
  // removal (the id alone can't name the layers to remove). Plain variable:
  // nothing renders from it.
  let config: LayerConfig | null = null;

  function apply() {
    const handle = mapView();
    const map = handle?.map();
    if (!config || !handle || !map) return;
    // `addSource` throws "Style is not done loading" if the style JSON hasn't
    // landed yet — and the config fetch usually wins that race on first load.
    // Skipping here is safe: `resync` runs from onLabelsReady once the style
    // (and the anchors) are ready, which is what actually puts the layers up.
    if (!map.style || !(map.style as unknown as { _loaded?: boolean })._loaded) return;
    addMvtLayer(config, handle.map);
  }

  function remove() {
    const current = config;
    const map = mapView()?.map();
    config = null;
    if (!current || !map) return;
    for (const def of buildNativeLayerDefs(current)) {
      if (map.getLayer(def.id)) map.removeLayer(def.id);
    }
    const sourceId = tileSourceId(current);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }

  createEffect(() => {
    const id = studyAreaId();
    if (!id) {
      remove();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const configs = await loadLayerConfigs();
        const resolved = getLayerConfigById(configs, id);
        if (cancelled) return;
        if (!resolved) {
          console.warn(`map.json: studyarea "${id}" not found in layers.json`);
          return;
        }
        // Native vector formats only. A COG/composite study area would need a
        // different add path, and the parquet/geoarrow formats this hook used
        // to accept no longer render at all.
        if (!isNativeVectorFormat(resolved.format)) {
          console.warn(
            `map.json: studyarea "${id}" has unsupported format "${resolved.format}" ` +
              `(expected mvt/pmtiles/flatgeobuf)`,
          );
          return;
        }
        config = resolved;
        apply();
      } catch (err) {
        if (!cancelled) console.error(`Failed to load studyarea "${id}":`, err);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  return { resync: apply };
}
