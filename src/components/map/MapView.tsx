import { useEffect, useRef } from "react";
import { Deck } from "@deck.gl/core";
import { BASEMAP } from "@deck.gl/carto";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<Deck | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: BASEMAP.POSITRON,
      interactive: false,
      center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
      zoom: INITIAL_VIEW_STATE.zoom,
      bearing: INITIAL_VIEW_STATE.bearing,
      pitch: INITIAL_VIEW_STATE.pitch,
    });
    mapRef.current = map;

    const deck = new Deck({
      parent: container,
      initialViewState: INITIAL_VIEW_STATE,
      controller: {
        dragRotate: false,
        touchRotate: false,
      },
      layers: [],
      onViewStateChange: ({ viewState: newViewState }) => {
        const vs = {
          ...newViewState,
          pitch: 0,
          bearing: 0,
        };
        map.jumpTo({
          center: [vs.longitude, vs.latitude],
          zoom: vs.zoom,
          bearing: vs.bearing,
          pitch: vs.pitch,
        });
      },
    });
    deckRef.current = deck;

    return () => {
      deck.finalize();
      map.remove();
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full relative" />
  );
}
