import { useEffect, useCallback } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { Feature } from "geojson";
import type { MapViewHandle } from "@/components/map/MapView";
import type { GeometryType, LayerConfig, LayerStyle } from "@/layers";
import type { useMapLayers } from "./use-map-layers";

/**
 * Dataset pushed by an embedding host (the Power BI custom visual). Features
 * are plain GeoJSON — the host converts its own formats (lng/lat columns, WKT)
 * before posting, keeping this protocol format-agnostic.
 */
export interface EmbedDataset {
  id: string;
  name?: string;
  geometryType?: GeometryType;
  style?: LayerStyle;
  features: Feature[];
}

/**
 * Runtime UI-config overrides pushed by an embedding host. Each field mirrors
 * the corresponding map.json flag; only the provided fields are applied. (Initial
 * view — center/zoom — is handled by the existing `map-command` `view` channel,
 * not here.)
 */
export interface EmbedConfig {
  searchbar?: boolean;
  navigation?: boolean;
  streetview?: boolean;
  share?: boolean;
  annotations?: boolean;
}

interface UseEmbedDataOptions {
  mapLeftLayers: ReturnType<typeof useMapLayers>;
  mapLeftRef: React.RefObject<MapViewHandle | null>;
  /** The left map is ready — triggers the `map-ready` handshake to the parent. */
  ready: boolean;
  /** Apply runtime UI-config overrides from a `map-config` message. */
  onConfig?: (config: EmbedConfig) => void;
}

const emptyRef: React.RefObject<MapRef | null> = { current: null };

/**
 * postMessage bridge for in-memory data layers, the dynamic-data counterpart of
 * the `map-command` bridge in use-url-commands.ts. An embedding host (e.g. the
 * Power BI custom visual) sends:
 *
 *   { type: "map-data", dataset: { id, name?, geometryType?, style?, features } }
 *     → upsert: replaces the layer with that id on the left map (remove + add).
 *       Empty `features` removes the layer.
 *   { type: "map-data-remove", id }
 *     → remove the layer with that id.
 *   { type: "map-config", searchbar?, navigation?, streetview?, share?, annotations? }
 *     → apply runtime UI-config overrides (only provided fields).
 *
 * When the left map becomes ready, `{ type: "map-ready", v: 1 }` is posted to
 * the parent window so the host knows it can start sending messages (the app
 * boots asynchronously inside the host's iframe).
 *
 * Validation is shape-based (no origin allow-list), consistent with the
 * existing map-command bridge.
 */
export function useEmbedData({ mapLeftLayers, mapLeftRef, ready, onConfig }: UseEmbedDataOptions) {
  const applyDataset = useCallback(
    (dataset: EmbedDataset) => {
      const mapRef = mapLeftRef.current?.mapRef ?? emptyRef;

      // Replace-on-update: every host update resends the full dataset.
      // removeLayer is a no-op when the id isn't present.
      mapLeftLayers.removeLayer(dataset.id, mapRef);
      if (!Array.isArray(dataset.features) || dataset.features.length === 0) return;

      const config: LayerConfig = {
        id: dataset.id,
        name: dataset.name || dataset.id,
        source: "",
        format: "geojson",
        geometryType: dataset.geometryType,
        style: dataset.style ?? {},
        data: { type: "FeatureCollection", features: dataset.features },
      };
      void mapLeftLayers.addLayer(config, mapRef);
    },
    [mapLeftLayers, mapLeftRef],
  );

  const removeDataset = useCallback(
    (id: string) => {
      mapLeftLayers.removeLayer(id, mapLeftRef.current?.mapRef ?? emptyRef);
    },
    [mapLeftLayers, mapLeftRef],
  );

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "map-data") {
        const dataset = data.dataset as EmbedDataset | undefined;
        if (!dataset || typeof dataset.id !== "string" || dataset.id.length === 0) {
          console.warn("map-data: missing or invalid dataset.id; ignoring");
          return;
        }
        applyDataset(dataset);
      } else if (data.type === "map-data-remove") {
        if (typeof data.id === "string" && data.id.length > 0) {
          removeDataset(data.id);
        }
      } else if (data.type === "map-config") {
        onConfig?.({
          searchbar: data.searchbar,
          navigation: data.navigation,
          streetview: data.streetview,
          share: data.share,
          annotations: data.annotations,
        });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [applyDataset, removeDataset, onConfig]);

  // Ready handshake: tell the embedding host it can start sending messages.
  useEffect(() => {
    if (!ready) return;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "map-ready", v: 1 }, "*");
    }
  }, [ready]);
}
