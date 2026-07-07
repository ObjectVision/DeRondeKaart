import { useState, useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildMvtLayerDefs, featureMatchesGeostyler, featureMatchesAreaFilter } from "@/layers";

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
export function useFeaturePick(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
) {
  const [result, setResult] = useState<FeatureInfoResult | null>(null);

  const handleClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const featuresByLayer = new Map<string, PickedFeature[]>();

      // Only pick from layers that have featureinfo configured and aren't excluded from picking
      const infoEntries = layerEntries.filter(
        (e) =>
          e.config.featureinfo &&
          e.config.format !== "cog" &&
          !e.config.excludeFromPicking,
      );
      if (infoEntries.length === 0) {
        setResult(null);
        return;
      }

      // --- deck.gl picking (GeoArrow/Parquet) ---
      const overlay = mapViewRef.current?.overlayRef?.current;
      if (overlay) {
        const picks = (overlay as any).pickMultipleObjects({
          x: event.point.x,
          y: event.point.y,
          radius: 2,
        });

        if (picks && Array.isArray(picks)) {
          for (const info of picks) {
            if (!info.object || !info.layer) continue;
            const deckLayerId: string = info.layer.id;

            // Match deck layer ID to a config entry
            const entry = infoEntries.find(
              (e) =>
                (e.config.format === "geoarrow" || e.config.format === "parquet" || e.config.format === "geoparquet") &&
                deckLayerId.startsWith(e.config.id),
            );
            if (!entry) continue;

            // info.object is an arrow.StructRowProxy — call toJSON() for plain object
            const props =
              typeof info.object.toJSON === "function"
                ? info.object.toJSON()
                : info.object;

            // Rule-filtered layers render non-matching features transparent;
            // treat them as dropped — not interactive — so clicks ignore them.
            if (!featureMatchesGeostyler(entry.config.geostyler, props as Record<string, unknown>)) {
              continue;
            }

            // Area-filtered features render transparent; treat them as dropped
            // too. (TODO: the hover pointer cursor may still appear over them.)
            if (!featureMatchesAreaFilter(props as Record<string, unknown>)) {
              continue;
            }

            const feature: PickedFeature = {
              layerConfigId: entry.config.id,
              layerName: entry.config.name,
              properties: props as Record<string, unknown>,
            };

            const existing = featuresByLayer.get(entry.config.id) ?? [];
            // Deduplicate — same feature is picked from multiple rule layers
            const isDuplicate = existing.some(
              (p) => JSON.stringify(p.properties) === JSON.stringify(feature.properties),
            );
            if (!isDuplicate) {
              existing.push(feature);
              featuresByLayer.set(entry.config.id, existing);
            }
          }
        }
      }

      // --- MapLibre picking (MVT) ---
      const map = mapViewRef.current?.mapRef?.current?.getMap();
      if (map) {
        // Collect all MVT layer IDs for entries that have featureinfo
        const mvtEntries = infoEntries.filter((e) => e.config.format === "mvt");
        const mvtLayerIds: string[] = [];
        for (const entry of mvtEntries) {
          const defs = buildMvtLayerDefs(entry.config);
          for (const def of defs) {
            if (map.getLayer(def.id)) {
              mvtLayerIds.push(def.id);
            }
          }
        }

        if (mvtLayerIds.length > 0) {
          const features = map.queryRenderedFeatures(event.point, {
            layers: mvtLayerIds,
          });

          for (const feature of features) {
            const mlLayerId = feature.layer?.id;
            if (!mlLayerId) continue;

            // Match MapLibre layer ID back to config entry
            const entry = mvtEntries.find((e) =>
              mlLayerId.startsWith(`mvt-layer-${e.config.id}`),
            );
            if (!entry) continue;

            const picked: PickedFeature = {
              layerConfigId: entry.config.id,
              layerName: entry.config.name,
              properties: feature.properties ?? {},
            };

            const existing = featuresByLayer.get(entry.config.id) ?? [];
            // Deduplicate by checking if same properties already exist
            const isDuplicate = existing.some(
              (p) => JSON.stringify(p.properties) === JSON.stringify(picked.properties),
            );
            if (!isDuplicate) {
              existing.push(picked);
              featuresByLayer.set(entry.config.id, existing);
            }
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
