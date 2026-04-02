import { useEffect, useRef, useState } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BASEMAP } from "@deck.gl/carto";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  loadLayerConfigs,
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayer,
} from "@/layers";
import type { LayerConfig } from "@/layers";

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

  useEffect(() => {
    loadAndRenderLayers();
  }, []);

  async function loadAndRenderLayers() {
    try {
      const configs = await loadLayerConfigs();
      for (const config of configs) {
        if (config.format === "parquet") {
          await loadParquetLayer(config);
        } else if (config.format === "geoarrow") {
          await loadArrowLayer(config);
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

  return (
    <Map
      initialViewState={INITIAL_VIEW_STATE}
      style={{ width: "100%", height: "100%" }}
      mapStyle={BASEMAP.POSITRON}
      dragRotate={false}
      pitchWithRotate={false}
    >
      <DeckGLOverlay layers={layers} />
    </Map>
  );
}
