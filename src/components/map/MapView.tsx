import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
import type { MapRef, ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BASEMAP } from "@deck.gl/carto";
import maplibregl from "maplibre-gl";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import "maplibre-gl/dist/maplibre-gl.css";
import type { useMapLayers } from "@/hooks/use-map-layers";

// Register COG protocol once
maplibregl.addProtocol("cog", cogProtocol);

export const INITIAL_VIEW_STATE = {
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

export interface MapViewHandle {
  mapRef: React.RefObject<MapRef | null>;
}

interface MapViewProps {
  layers: ReturnType<typeof useMapLayers>;
  style?: React.CSSProperties;
  viewState?: Record<string, unknown>;
  onMove?: (evt: ViewStateChangeEvent) => void;
  onLoad?: () => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  function MapView({ layers, style, viewState, onMove, onLoad }, ref) {
    const mapRef = useRef<MapRef>(null);

    useImperativeHandle(ref, () => ({ mapRef }), []);

    useEffect(() => {
      function onFlyTo(e: Event) {
        const { latitude, longitude } = (e as CustomEvent).detail;
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 12 });
      }
      window.addEventListener("map:flyto", onFlyTo);
      return () => window.removeEventListener("map:flyto", onFlyTo);
    }, []);

    const mapProps: Record<string, unknown> = {};
    if (viewState) {
      Object.assign(mapProps, viewState);
    } else {
      mapProps.initialViewState = INITIAL_VIEW_STATE;
    }

    return (
      <Map
        ref={mapRef}
        {...mapProps}
        style={style ?? { width: "100%", height: "100%" }}
        mapStyle={BASEMAP.POSITRON}
        dragRotate={false}
        pitchWithRotate={false}
        onLoad={onLoad}
        onMove={onMove}
      >
        <DeckGLOverlay layers={layers.visibleDeckLayers} />
      </Map>
    );
  },
);
