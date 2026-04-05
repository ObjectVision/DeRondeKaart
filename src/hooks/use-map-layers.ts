import { useRef, useState, useCallback } from "react";
import type { Layer } from "@deck.gl/core";
import type { MapRef } from "react-map-gl/maplibre";
import {
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayers,
  createMVTLayers,
} from "@/layers";
import type { LayerConfig } from "@/layers";

export interface LayerEntry {
  config: LayerConfig;
  visible: boolean;
}

export function useMapLayers() {
  const [deckLayers, setDeckLayers] = useState<Layer[]>([]);
  const [layerEntries, setLayerEntries] = useState<LayerEntry[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [hiddenRules, setHiddenRules] = useState<globalThis.Map<string, Set<string>>>(new globalThis.Map());
  const layerEntriesRef = useRef<LayerEntry[]>([]);

  function addLayers(newLayers: Layer[]) {
    setDeckLayers((prev) => [...prev, ...newLayers]);
  }

  function updateLayerEntries(updater: (prev: LayerEntry[]) => LayerEntry[]) {
    setLayerEntries((prev) => {
      const next = updater(prev);
      layerEntriesRef.current = next;
      return next;
    });
  }

  async function addLayer(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
    updateLayerEntries((prev) => {
      if (prev.some((e) => e.config.id === config.id)) return prev;
      return [...prev, { config, visible: true }];
    });

    try {
      if (config.format === "parquet") {
        await loadParquetBatches(config.source, (batchIndex, table) => {
          const layers = createGeoArrowLayers(config, table, batchIndex);
          addLayers(layers);
        });
      } else if (config.format === "geoarrow") {
        await loadArrowBatches(config.source, (batchIndex, table) => {
          const layers = createGeoArrowLayers(config, table, batchIndex);
          addLayers(layers);
        });
      } else if (config.format === "mvt") {
        const layers = createMVTLayers(config);
        addLayers(layers);
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
    } catch (err) {
      console.error(`Failed to load layer "${config.id}":`, err);
      updateLayerEntries((prev) => prev.filter((e) => e.config.id !== config.id));
    }
  }

  function removeLayer(layerId: string, mapRef: React.RefObject<MapRef | null>) {
    updateLayerEntries((prev) => prev.filter((e) => e.config.id !== layerId));

    // Remove all deck layers belonging to this config id
    setDeckLayers((prev) => prev.filter((l) => !layerBelongsTo(l.id, layerId)));

    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });

    setHiddenRules((prev) => {
      const next = new globalThis.Map(prev);
      next.delete(layerId);
      return next;
    });

    const map = mapRef.current?.getMap();
    const cogLayerId = `cog-layer-${layerId}`;
    const cogSourceId = `cog-source-${layerId}`;
    if (map?.getLayer(cogLayerId)) map.removeLayer(cogLayerId);
    if (map?.getSource(cogSourceId)) map.removeSource(cogSourceId);
  }

  function hideLayer(layerId: string, mapRef: React.RefObject<MapRef | null>) {
    setHiddenIds((prev) => {
      if (prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.add(layerId);
      return next;
    });

    // Clone all child deck layers for this config to visible: false
    setDeckLayers((prev) =>
      prev.map((l) =>
        layerBelongsTo(l.id, layerId) ? l.clone({ visible: false }) : l,
      ),
    );

    // COG layers are native MapLibre layers
    const map = mapRef.current?.getMap();
    const cogLayerId = `cog-layer-${layerId}`;
    if (map?.getLayer(cogLayerId)) {
      map.setLayoutProperty(cogLayerId, "visibility", "none");
    }
  }

  const toggleLayer = useCallback(
    (layerId: string, mapRef: React.RefObject<MapRef | null>) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        const willBeVisible = next.has(layerId);
        if (willBeVisible) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }

        // Clone all child deck layers for this config
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) =>
            layerBelongsTo(l.id, layerId) ? l.clone({ visible: willBeVisible }) : l,
          ),
        );

        // COG layers
        const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
        if (entry?.config.format === "cog") {
          const map = mapRef.current?.getMap();
          const cogLayerId = `cog-layer-${layerId}`;
          if (map?.getLayer(cogLayerId)) {
            map.setLayoutProperty(
              cogLayerId,
              "visibility",
              willBeVisible ? "visible" : "none",
            );
          }
        }

        return next;
      });
    },
    [],
  );

  const toggleRule = useCallback(
    (layerId: string, ruleName: string) => {
      setHiddenRules((prev) => {
        const next = new globalThis.Map(prev);
        const layerRules = new Set(next.get(layerId) ?? []);

        const willBeVisible = layerRules.has(ruleName);
        if (willBeVisible) {
          layerRules.delete(ruleName);
        } else {
          layerRules.add(ruleName);
        }

        if (layerRules.size === 0) {
          next.delete(layerId);
        } else {
          next.set(layerId, layerRules);
        }

        // Find the specific child layer for this rule and clone with visible toggle
        // Child layer IDs follow the pattern: {configId}-batch-{n}-{ruleName} or {configId}-{ruleName}
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) => {
            if (l.id.endsWith(`-${ruleName}`) && layerBelongsTo(l.id, layerId)) {
              return l.clone({ visible: willBeVisible });
            }
            return l;
          }),
        );

        return next;
      });
    },
    [],
  );

  return {
    layerEntries,
    deckLayers,
    hiddenIds,
    hiddenRules,
    addLayer,
    removeLayer,
    hideLayer,
    toggleLayer,
    toggleRule,
  };
}

/**
 * Check if a deck layer ID belongs to a given config ID.
 * Layer IDs follow patterns like:
 *   "{configId}-batch-{n}" (flat style)
 *   "{configId}-batch-{n}-{ruleName}" (geostyler child)
 *   "{configId}" (MVT flat style)
 *   "{configId}-{ruleName}" (MVT geostyler child)
 */
function layerBelongsTo(deckLayerId: string, configId: string): boolean {
  return deckLayerId === configId || deckLayerId.startsWith(configId + "-");
}
