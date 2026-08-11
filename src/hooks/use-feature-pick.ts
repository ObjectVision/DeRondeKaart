import { useState, useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import {
  buildNativeLayerDefs,
  expandForMapQueries,
  isNativeVectorFormat,
} from "@/layers";

export interface PickedFeature {
  layerConfigId: string;
  layerName: string;
  properties: Record<string, unknown>;
}

export interface FeatureInfoResult {
  screenX: number;
  screenY: number;
  featuresByLayer: Map<string, PickedFeature[]>;
}

/**
 * Hook that handles map click picking for both deck.gl (GeoArrow/Parquet)
 * and native MapLibre (MVT) layers, returning grouped feature info results.
 */
export interface UseFeaturePickResult {
  /** The current pick, or null when nothing is selected. */
  result: FeatureInfoResult | null;
  handleClick: (event: MapLayerMouseEvent) => void;
  clear: () => void;
}

export function useFeaturePick(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
): UseFeaturePickResult {
  const [result, setResult] = useState<FeatureInfoResult | null>(null);

  const handleClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const featuresByLayer = new Map<string, PickedFeature[]>();
      // The same feature is picked once per rule layer; dedupe on a cheap
      // stable key instead of stringifying property bags per pair (O(n²)).
      const seen = new Set<string>();

      // Only pick from layers that have featureinfo configured and aren't
      // excluded from picking. Composite entries are expanded to their
      // children (the configs actually on the map) but keep the PARENT's
      // featureinfo/name/id as the owner — picks report the composite.
      const infoEntries = expandForMapQueries(layerEntries).filter(
        (e) =>
          e.featureinfo &&
          e.config.format !== "cog" &&
          !e.excludeFromPicking,
      );
      if (infoEntries.length === 0) {
        setResult(null);
        return;
      }

      // --- MapLibre picking (MVT/PMTiles/FlatGeobuf/GeoJSON) ---
      const map = mapViewRef.current?.mapRef?.current?.getMap();
      if (map) {
        // Collect all native layer IDs for entries that have featureinfo
        const nativeEntries = infoEntries.filter(
          (e) => isNativeVectorFormat(e.config.format),
        );
        const nativeLayerIds: string[] = [];
        for (const entry of nativeEntries) {
          const defs = buildNativeLayerDefs(entry.config);
          for (const def of defs) {
            if (map.getLayer(def.id)) {
              nativeLayerIds.push(def.id);
            }
          }
        }

        if (nativeLayerIds.length > 0) {
          const features = map.queryRenderedFeatures(event.point, {
            layers: nativeLayerIds,
          });

          for (const feature of features) {
            const mlLayerId = feature.layer?.id;
            if (!mlLayerId) continue;

            // Match MapLibre layer ID back to its config entry. The id prefix
            // is format-derived (mvt-layer-… / fgb-layer-… / pmtiles-layer-…),
            // so compare against the defs rather than rebuilding prefixes here.
            const entry = nativeEntries.find((e) =>
              buildNativeLayerDefs(e.config).some((d) => d.id === mlLayerId),
            );
            if (!entry) continue;

            const properties = feature.properties ?? {};
            // Same feature returned once per rule layer → duplicate. Prefer the
            // feature id (flatgeobuf assigns one; MVT tiles may carry one) —
            // property JSON alone merges distinct features that share all
            // property values.
            const key = `${entry.ownerId}:${feature.id ?? JSON.stringify(properties)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const picked: PickedFeature = {
              layerConfigId: entry.ownerId,
              layerName: entry.ownerName,
              properties,
            };

            const existing = featuresByLayer.get(entry.ownerId) ?? [];
            existing.push(picked);
            featuresByLayer.set(entry.ownerId, existing);
          }
        }
      }

      if (featuresByLayer.size > 0) {
        setResult({
          screenX: event.point.x,
          screenY: event.point.y,
          featuresByLayer,
        });
      } else {
        setResult(null);
      }
    },
    [layerEntries, mapViewRef],
  );

  const clear = useCallback(() => setResult(null), []);

  return { result, handleClick, clear };
}
