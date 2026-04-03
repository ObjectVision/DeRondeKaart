import { useRef, useState } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
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

// Register COG protocol once
maplibregl.addProtocol("cog", cogProtocol);

const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

function DeckGLOverlay(props: { layers: Layer[] }) {
  const overlay = useControl(() => new MapboxOverlay({ interleaved: true }));
  overlay.setProps({ layers: props.layers });
  return null;
}

export function MapView() {
  const layersRef = useRef<globalThis.Map<string, Layer>>(new globalThis.Map());
  const [layers, setLayers] = useState<Layer[]>([]);
  const mapRef = useRef<maplibregl.Map | null>(null);

  function handleMapLoad(e: maplibregl.MapLibreEvent) {
    mapRef.current = e.target;
    loadAndRenderLayers();
  }

  async function loadAndRenderLayers() {
    try {
      const configs = await loadLayerConfigs();
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
      layersRef.current.set(config.id, layer);
      setLayers(Array.from(layersRef.current.values()));
    });
  }

  async function loadArrowLayer(config: LayerConfig) {
    await loadArrowBatches(config.source, (batchIndex, table) => {
      const layer = createGeoArrowLayer(config, table, batchIndex);
      layersRef.current.set(config.id, layer);
      setLayers(Array.from(layersRef.current.values()));
    });
  }

  function loadMVTLayer(config: LayerConfig) {
    const layer = createMVTLayer(config);
    layersRef.current.set(config.id, layer);
    setLayers(Array.from(layersRef.current.values()));
  }

  function loadCOGLayer(config: LayerConfig) {
    const map = mapRef.current;
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

  return (
    <Map
      initialViewState={INITIAL_VIEW_STATE}
      style={{ width: "100%", height: "100%" }}
      mapStyle={BASEMAP.POSITRON}
      dragRotate={false}
      pitchWithRotate={false}
      onLoad={handleMapLoad}
    >
      <DeckGLOverlay layers={layers} />
    </Map>
  );
}
