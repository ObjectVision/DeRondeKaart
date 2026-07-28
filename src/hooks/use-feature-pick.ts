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
      // The same feature is picked once per rule layer; dedupe on a cheap
      // stable key instead of stringifying property bags per pair (O(n²)).
      const seen = new Set<string>();

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
            if (!info.layer) continue;
            // Icon layers feed positions as binary attributes, so deck has no
            // row object to attach — resolve it from the record batch riding
            // on the layer's data (see createIconPointLayer).
            let object = info.object;
            if (!object && typeof info.index === "number" && info.index >= 0) {
              const data = (info.layer.props as { data?: { data?: unknown } }).data;
              const batch = data?.data as { get?: (i: number) => unknown } | undefined;
              if (batch?.get) object = batch.get(info.index);
            }
            if (!object) continue;
            const deckLayerId: string = info.layer.id;

            // Match deck layer ID to a config entry
            const entry = infoEntries.find(
              (e) =>
                (e.config.format === "geoarrow" || e.config.format === "parquet") &&
                deckLayerId.startsWith(e.config.id),
            );
            if (!entry) continue;

            // The picked object is an arrow.StructRowProxy — toJSON() for a plain object
            const props =
              typeof (object as { toJSON?: () => unknown }).toJSON === "function"
                ? (object as { toJSON: () => unknown }).toJSON()
                : object;

            // Same feature picked via another rule layer → duplicate. Keyed on
            // the stringified property bag ONCE per pick (info.index can't be
            // used: it is per record batch, so it collides across batches).
            const key = `${entry.config.id}:${JSON.stringify(props)}`;
            if (seen.has(key)) continue;
            seen.add(key);

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
            existing.push(feature);
            featuresByLayer.set(entry.config.id, existing);
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

            const properties = feature.properties ?? {};
            // Same feature returned once per rule layer → duplicate (stringify
            // once per pick, not per pair).
            const key = `${entry.config.id}:${JSON.stringify(properties)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const picked: PickedFeature = {
              layerConfigId: entry.config.id,
              layerName: entry.config.name,
              properties,
            };

            const existing = featuresByLayer.get(entry.config.id) ?? [];
            existing.push(picked);
            featuresByLayer.set(entry.config.id, existing);
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
