import { useRef, useState, useCallback, useEffect } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BASEMAP } from "@deck.gl/carto";
import maplibregl from "maplibre-gl";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  loadLayerConfigs,
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayer,
  createMVTLayer,
} from "@/layers";
import type { LayerConfig } from "@/layers";
import { Legend } from "@/components/ui/legend";
import { MapControls } from "@/components/ui/map-controls";

// Register COG protocol once
maplibregl.addProtocol("cog", cogProtocol);

const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

export interface LayerEntry {
  config: LayerConfig;
  visible: boolean;
}

function DeckGLOverlay(props: { layers: Layer[] }) {
  const overlay = useControl(() => new MapboxOverlay({ interleaved: true }));
  overlay.setProps({ layers: props.layers });
  return null;
}

export function MapView() {
  const deckLayersRef = useRef<globalThis.Map<string, Layer>>(new globalThis.Map());
  const [deckLayers, setDeckLayers] = useState<Layer[]>([]);
  const [layerEntries, setLayerEntries] = useState<LayerEntry[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const mapRef = useRef<MapRef>(null);

  function handleMapLoad() {
    loadAndRenderLayers();
  }

  async function loadAndRenderLayers() {
    try {
      const configs = await loadLayerConfigs();
      const entries: LayerEntry[] = configs.map((c) => ({ config: c, visible: true }));
      setLayerEntries(entries);

      for (const config of configs) {
        if (config.format === "parquet") {
          await loadParquetLayer(config);
        } else if (config.format === "geoarrow") {
          await loadArrowLayer(config);
        } else if (config.format === "mvt") {
          loadMVTLayer(config);
        } else if (config.format === "cog") {
          loadCOGLayer(config);
        }
      }
    } catch (err) {
      console.error("Failed to load layers:", err);
    }
  }

  async function loadParquetLayer(config: LayerConfig) {
    await loadParquetBatches(config.source, (batchIndex, table) => {
      const layer = createGeoArrowLayer(config, table, batchIndex);
      deckLayersRef.current.set(config.id, layer);
      syncDeckLayers();
    });
  }

  async function loadArrowLayer(config: LayerConfig) {
    await loadArrowBatches(config.source, (batchIndex, table) => {
      const layer = createGeoArrowLayer(config, table, batchIndex);
      deckLayersRef.current.set(config.id, layer);
      syncDeckLayers();
    });
  }

  function loadMVTLayer(config: LayerConfig) {
    const layer = createMVTLayer(config);
    deckLayersRef.current.set(config.id, layer);
    syncDeckLayers();
  }

  function loadCOGLayer(config: LayerConfig) {
    const map = mapRef.current?.getMap();
    if (!map) return;

    const sourceId = `cog-source-${config.id}`;
    const layerId = `cog-layer-${config.id}`;

    map.addSource(sourceId, {
      type: "raster",
      url: `cog://${config.source}`,
      tileSize: 256,
    });

    map.addLayer({
      id: layerId,
      source: sourceId,
      type: "raster",
      paint: {
        "raster-opacity": config.style.opacity ?? 1,
      },
    });
  }

  function syncDeckLayers() {
    setDeckLayers(Array.from(deckLayersRef.current.values()));
  }

  const handleToggleLayer = useCallback(
    (layerId: string) => {
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
            const isNowVisible = prev.has(layerId); // was hidden, toggling to visible
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

  const handleZoomIn = useCallback(() => {
    mapRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    mapRef.current?.zoomOut();
  }, []);

  useEffect(() => {
    function onFlyTo(e: Event) {
      const { latitude, longitude } = (e as CustomEvent).detail;
      mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 12 });
    }
    window.addEventListener("map:flyto", onFlyTo);
    return () => window.removeEventListener("map:flyto", onFlyTo);
  }, []);

  // Filter deck.gl layers by visibility
  const visibleDeckLayers = deckLayers.filter((l) => !hiddenIds.has(l.id.split("-batch-")[0]));

  return (
    <Map
      ref={mapRef}
      initialViewState={INITIAL_VIEW_STATE}
      style={{ width: "100%", height: "100%" }}
      mapStyle={BASEMAP.POSITRON}
      dragRotate={false}
      pitchWithRotate={false}
      onLoad={handleMapLoad}
    >
      <DeckGLOverlay layers={visibleDeckLayers} />
      <Legend entries={layerEntries} hiddenIds={hiddenIds} onToggle={handleToggleLayer} />
      <MapControls onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />
    </Map>
  );
}
