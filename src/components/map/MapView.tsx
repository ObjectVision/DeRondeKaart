import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
import type { MapRef, ViewStateChangeEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BASEMAP } from "@deck.gl/carto";
import maplibregl from "maplibre-gl";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import "maplibre-gl/dist/maplibre-gl.css";

// Register COG protocol once
maplibregl.addProtocol("cog", cogProtocol);

export const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

function DeckGLOverlay(
  props: { layers: Layer[]; overlayRef: React.RefObject<MapboxOverlay | null> },
) {
  const overlay = useControl(() => new MapboxOverlay({ interleaved: true }));
  props.overlayRef.current = overlay;
  overlay.setProps({ layers: props.layers });
  return null;
}

export interface MapViewHandle {
  mapRef: React.RefObject<MapRef | null>;
  overlayRef: React.RefObject<MapboxOverlay | null>;
}

/** Read current layers from a MapboxOverlay */
export function getDeckLayers(overlayRef: React.RefObject<MapboxOverlay | null>): Layer[] {
  if (!overlayRef.current) return [];
  return ((overlayRef.current as any).props?.layers ?? []) as Layer[];
}

/** Clone a specific layer with new props and push the updated array to the overlay */
export function updateDeckLayer(
  overlayRef: React.RefObject<MapboxOverlay | null>,
  layerId: string,
  newProps: Record<string, unknown>,
) {
  if (!overlayRef.current) return;
  const updatedLayers = getDeckLayers(overlayRef).map((layer: Layer) =>
    layer.id === layerId ? layer.clone(newProps) : layer,
  );
  overlayRef.current.setProps({ layers: updatedLayers });
}

interface MapViewProps {
  layers: Layer[];
  style?: React.CSSProperties;
  viewState?: Record<string, unknown>;
  onMove?: (evt: ViewStateChangeEvent) => void;
  onClick?: (evt: MapLayerMouseEvent) => void;
  onLoad?: () => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  function MapView({ layers, style, viewState, onMove, onClick, onLoad }, ref) {
    const mapRef = useRef<MapRef>(null);
    const overlayRef = useRef<MapboxOverlay | null>(null);

    useImperativeHandle(ref, () => ({ mapRef, overlayRef }), []);

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
        onClick={onClick}
      >
        <DeckGLOverlay layers={layers} overlayRef={overlayRef} />
      </Map>
    );
  },
);
