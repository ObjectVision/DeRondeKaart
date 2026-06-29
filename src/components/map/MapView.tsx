import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { Layer } from "@deck.gl/core";
import { Map, useControl } from "react-map-gl/maplibre";
import type { MapRef, ViewStateChangeEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, LayerSpecification } from "maplibre-gl";
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

export type ViewState = typeof INITIAL_VIEW_STATE;

/** URL of the Positron basemap (no labels, roads, or water) rendered as the background style. */
const BASE_STYLE_URL = "/positron-base.json";
/** URL of the Positron overlay (labels, roads, water); its layers are appended on top of user data. */
const LABELS_STYLE_URL = "/positron-overlay.json";

/** Hidden tag we attach to a map after labels have been added, listing their ids. */
type LabelTaggedMap = MapLibreMap & {
  __labelLayerIds?: string[];
  /** Deck layer ids of the always-on-top study-area layer, kept above labels. */
  __studyareaLayerIds?: string[];
};

/** Fetch positron-labels.json and add its symbol layers on top of the current style. Idempotent. */
async function loadLabelLayers(map: MapLibreMap) {
  const tagged = map as LabelTaggedMap;
  if (tagged.__labelLayerIds) return;
  const resp = await fetch(LABELS_STYLE_URL);
  if (!resp.ok) {
    console.warn(`Failed to load labels style: ${resp.statusText}`);
    return;
  }
  const style = (await resp.json()) as { layers: LayerSpecification[] };
  const ids: string[] = [];
  for (const layer of style.layers) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer);
    ids.push(layer.id);
  }
  tagged.__labelLayerIds = ids;
}

function labelsAreAtTop(map: MapLibreMap): boolean {
  const ids = (map as LabelTaggedMap).__labelLayerIds;
  if (!ids || ids.length === 0) return true;
  const styleLayers = map.getStyle().layers ?? [];
  if (styleLayers.length < ids.length) return false;
  const labelSet = new Set(ids);
  return styleLayers.slice(-ids.length).every((l) => labelSet.has(l.id));
}

/**
 * Move every label layer back to the top of the maplibre layer stack. Called
 * as a safety net when a user-data insertion path can't pass `beforeId`.
 * No-op until labels have been loaded, and no-op when already at the top
 * (safe to call from high-frequency listeners like `styledata`).
 */
export function bringLabelsToTop(map: MapLibreMap) {
  const ids = (map as LabelTaggedMap).__labelLayerIds;
  if (!ids) return;
  if (labelsAreAtTop(map)) return;
  for (const id of ids) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/**
 * Move the study-area layers back to the very top of the maplibre stack — above
 * the labels. Must be called immediately AFTER `bringLabelsToTop`, since that
 * moves labels above all interleaved deck layers (including the study area).
 * No-op until the study area is registered. Safe to call repeatedly.
 */
export function bringStudyareaToTop(map: MapLibreMap) {
  const ids = (map as LabelTaggedMap).__studyareaLayerIds;
  if (!ids || ids.length === 0) return;
  for (const id of ids) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

/**
 * Return the id of the first (lowest) label layer if labels have been loaded.
 * Pass this as `beforeId` when inserting user data layers so they sit below
 * the label stack deterministically — surviving deck.gl's deferred inserts.
 */
export function getFirstLabelId(map: MapLibreMap): string | undefined {
  const ids = (map as LabelTaggedMap).__labelLayerIds;
  return ids && ids.length > 0 ? ids[0] : undefined;
}

function DeckGLOverlay(props: {
  layers: Layer[];
  overlayRef: React.RefObject<MapboxOverlay | null>;
  hoverRef: React.RefObject<boolean>;
  mvtHoverRef: React.RefObject<boolean>;
  clickableIdsRef: React.RefObject<string[]>;
}) {
  const { hoverRef, mvtHoverRef, clickableIdsRef } = props;
  const overlay = useControl(
    () =>
      new MapboxOverlay({
        interleaved: true,
        // Use deck's built-in async hover (from its existing picking pass) rather
        // than a synchronous pickObject per mousemove — the latter stalls the main
        // thread and makes Chromium flash the blue "progress" cursor.
        onHover: (info) => {
          const id = info?.layer?.id;
          hoverRef.current = id
            ? clickableIdsRef.current.some((cid) => id.startsWith(cid))
            : false;
        },
        // deck owns the canvas cursor in interleaved mode; read the live hover
        // flags so a pointer shows over clickable features, grabbing while panning.
        getCursor: ({ isDragging }) =>
          isDragging
            ? "grabbing"
            : hoverRef.current || mvtHoverRef.current
              ? "pointer"
              : "grab",
      }),
  );
  props.overlayRef.current = overlay;
  overlay.setProps({ layers: props.layers });
  return null;
}

export interface MapViewHandle {
  mapRef: React.RefObject<MapRef | null>;
  overlayRef: React.RefObject<MapboxOverlay | null>;
  /** Live flag: mouse is over a clickable deck (GeoArrow/Parquet) feature. */
  hoverRef: React.RefObject<boolean>;
  /** Live flag: mouse is over a clickable MVT feature (set from MapLibre hover). */
  mvtHoverRef: React.RefObject<boolean>;
  /** Config ids of clickable layers; deck onHover matches picked layer ids against these. */
  clickableIdsRef: React.RefObject<string[]>;
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
  /** Always-on-top layers (e.g. the study area), pinned above the basemap labels. */
  topLayers?: Layer[];
  style?: React.CSSProperties;
  viewState?: Record<string, unknown>;
  onMove?: (evt: ViewStateChangeEvent) => void;
  onClick?: (evt: MapLayerMouseEvent) => void;
  onMouseMove?: (evt: MapLayerMouseEvent) => void;
  onLoad?: () => void;
  onLabelsReady?: (map: MapLibreMap) => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  function MapView({ layers, topLayers, style, viewState, onMove, onClick, onMouseMove, onLoad, onLabelsReady }, ref) {
    const mapRef = useRef<MapRef>(null);
    const overlayRef = useRef<MapboxOverlay | null>(null);
    const hoverRef = useRef<boolean>(false);
    const mvtHoverRef = useRef<boolean>(false);
    const clickableIdsRef = useRef<string[]>([]);

    useImperativeHandle(
      ref,
      () => ({ mapRef, overlayRef, hoverRef, mvtHoverRef, clickableIdsRef }),
      [],
    );

    useEffect(() => {
      function onFlyTo(e: Event) {
        const { latitude, longitude } = (e as CustomEvent).detail;
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 12 });
      }
      window.addEventListener("map:flyto", onFlyTo);
      return () => window.removeEventListener("map:flyto", onFlyTo);
    }, []);

    // Whenever the deck.gl layer set changes the interleaved overlay re-syncs
    // them into the maplibre style at the top — push labels back above them,
    // then re-pin the study area above the labels. Also keep the map's record
    // of which deck ids are the study-area layers in sync with topLayers.
    useEffect(() => {
      const map = mapRef.current?.getMap();
      if (!map) return;
      (map as LabelTaggedMap).__studyareaLayerIds = (topLayers ?? []).map((l) => l.id);
      bringLabelsToTop(map);
      bringStudyareaToTop(map);
    }, [layers, topLayers]);

    function handleLoad() {
      const map = mapRef.current?.getMap();
      if (map) {
        (map as LabelTaggedMap).__studyareaLayerIds = (topLayers ?? []).map((l) => l.id);
        loadLabelLayers(map).then(() => {
          bringLabelsToTop(map);
          bringStudyareaToTop(map);
          onLabelsReady?.(map);
        });
      }
      onLoad?.();
    }

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
        mapStyle={BASE_STYLE_URL}
        dragRotate={false}
        pitchWithRotate={false}
        onLoad={handleLoad}
        onMove={onMove}
        onClick={onClick}
        onMouseMove={onMouseMove}
      >
        <DeckGLOverlay
          layers={topLayers && topLayers.length > 0 ? [...layers, ...topLayers] : layers}
          overlayRef={overlayRef}
          hoverRef={hoverRef}
          mvtHoverRef={mvtHoverRef}
          clickableIdsRef={clickableIdsRef}
        />
      </Map>
    );
  },
);
