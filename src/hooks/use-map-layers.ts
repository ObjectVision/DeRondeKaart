import { useRef, useState, useCallback } from "react";
import type { Layer } from "@deck.gl/core";
import type { MapRef } from "react-map-gl/maplibre";
import {
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayer,
  createMVTLayer,
} from "@/layers";
import type { LayerConfig } from "@/layers";

export interface LayerEntry {
  config: LayerConfig;
  visible: boolean;
}

export function useMapLayers() {
  const deckLayersRef = useRef<globalThis.Map<string, Layer>>(new globalThis.Map());
  const [deckLayers, setDeckLayers] = useState<Layer[]>([]);
  const [layerEntries, setLayerEntries] = useState<LayerEntry[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  function syncDeckLayers() {
    setDeckLayers(Array.from(deckLayersRef.current.values()));
  }

  async function addLayer(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
    // Add to entries if not already present
    setLayerEntries((prev) => {
      if (prev.some((e) => e.config.id === config.id)) return prev;
      return [...prev, { config, visible: true }];
    });

    if (config.format === "parquet") {
      await loadParquetBatches(config.source, (batchIndex, table) => {
        const layer = createGeoArrowLayer(config, table, batchIndex);
        deckLayersRef.current.set(config.id, layer);
        syncDeckLayers();
      });
    } else if (config.format === "geoarrow") {
      await loadArrowBatches(config.source, (batchIndex, table) => {
        const layer = createGeoArrowLayer(config, table, batchIndex);
        deckLayersRef.current.set(config.id, layer);
        syncDeckLayers();
      });
    } else if (config.format === "mvt") {
      const layer = createMVTLayer(config);
      deckLayersRef.current.set(config.id, layer);
      syncDeckLayers();
    } else if (config.format === "cog") {
      const map = mapRef.current?.getMap();
      if (!map) return;

      const sourceId = `cog-source-${config.id}`;
      const layerId = `cog-layer-${config.id}`;

      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster",
          url: `cog://${config.source}`,
          tileSize: 256,
        });
        map.addLayer({
          id: layerId,
          source: sourceId,
          type: "raster",
          paint: { "raster-opacity": config.style.opacity ?? 1 },
        });
      }
    }
  }

  const toggleLayer = useCallback(
    (layerId: string, mapRef: React.RefObject<MapRef | null>) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        if (next.has(layerId)) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }

        // Toggle COG layers via MapLibre
        const entry = layerEntries.find((e) => e.config.id === layerId);
        if (entry?.config.format === "cog") {
          const map = mapRef.current?.getMap();
          const cogLayerId = `cog-layer-${layerId}`;
          if (map?.getLayer(cogLayerId)) {
            const isNowVisible = prev.has(layerId);
            map.setLayoutProperty(
              cogLayerId,
              "visibility",
              isNowVisible ? "visible" : "none",
            );
          }
        }

        return next;
      });
    },
    [layerEntries],
  );

  const visibleDeckLayers = deckLayers.filter(
    (l) => !hiddenIds.has(l.id.split("-batch-")[0]),
  );

  return {
    layerEntries,
    hiddenIds,
    visibleDeckLayers,
    addLayer,
    toggleLayer,
  };
}
