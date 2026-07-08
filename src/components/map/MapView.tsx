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

/**
 * Selectable background basemaps. Each entry pairs a base style (background +
 * geometry, no labels — rendered under user data) with the matching overlay
 * (labels, roads, water — appended on top of user data by `loadLabelLayers`).
 * The `label` is what the legend's basemap toggle shows.
 */
export interface Basemap {
  id: string;
  label: string;
  base: string;
  overlay: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: "maptiler-basic",
    label: "MapTiler Basic",
    base: "/maptiler-basic-base.json",
    overlay: "/maptiler-basic-overlay.json",
  },
  // Positron is temporarily removed from the cycle (kept here for easy restore).
  // {
  //   id: "positron",
  //   label: "Positron",
  //   base: "/positron-base.json",
  //   overlay: "/positron-overlay.json",
  // },
  {
    // PDOK aerial photography (RGB 8cm). The imagery replaces the vector base;
    // only the labels (no roads/water) are drawn on top so place names stay
    // readable over the photo.
    id: "luchtfoto",
    label: "Luchtfoto",
    base: "/pdok-luchtfoto-base.json",
    overlay: "/maptiler-basic-labels.json",
  },
];

export const DEFAULT_BASEMAP_ID = BASEMAPS[0].id;

function basemapById(id: string): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

/** Hidden tag we attach to a map after labels have been added, listing their ids. */
type LabelTaggedMap = MapLibreMap & {
  __labelLayerIds?: string[];
  /** Deck layer ids of the always-on-top study-area layer, kept above labels. */
  __studyareaLayerIds?: string[];
};

/** Fetch the overlay style and add its label/road/water layers on top of the current style. Idempotent. */
async function loadLabelLayers(map: MapLibreMap, overlayUrl: string) {
  const tagged = map as LabelTaggedMap;
  if (tagged.__labelLayerIds) return;
  const resp = await fetch(overlayUrl);
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
  drawModeRef: React.RefObject<boolean>;
}) {
  const { hoverRef, mvtHoverRef, clickableIdsRef, drawModeRef } = props;
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
        // flags so a pointer shows over clickable features, grabbing while panning,
        // crosshair while the area-select tool is armed.
        getCursor: ({ isDragging }) =>
          drawModeRef.current
            ? "crosshair"
            : isDragging
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
  /** Live flag: the area-select draw mode is armed (crosshair cursor). */
  drawModeRef: React.RefObject<boolean>;
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
  /** Selected background basemap; changing it swaps only the base style. */
  basemapId?: string;
  style?: React.CSSProperties;
  viewState?: Record<string, unknown>;
  onMove?: (evt: ViewStateChangeEvent) => void;
  onClick?: (evt: MapLayerMouseEvent) => void;
  onMouseMove?: (evt: MapLayerMouseEvent) => void;
  onMouseDown?: (evt: MapLayerMouseEvent) => void;
  onMouseUp?: (evt: MapLayerMouseEvent) => void;
  onLoad?: () => void;
  onLabelsReady?: (map: MapLibreMap) => void;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  function MapView({ layers, topLayers, basemapId, style, viewState, onMove, onClick, onMouseMove, onMouseDown, onMouseUp, onLoad, onLabelsReady }, ref) {
    const mapRef = useRef<MapRef>(null);
    const overlayRef = useRef<MapboxOverlay | null>(null);
    const hoverRef = useRef<boolean>(false);
    const mvtHoverRef = useRef<boolean>(false);
    const clickableIdsRef = useRef<string[]>([]);
    const drawModeRef = useRef<boolean>(false);
    const basemap = basemapById(basemapId ?? DEFAULT_BASEMAP_ID);
    // The basemap applied on the last completed (re)load — used to detect a swap.
    const appliedBasemapRef = useRef<string>(basemap.id);

    useImperativeHandle(
      ref,
      () => ({ mapRef, overlayRef, hoverRef, mvtHoverRef, clickableIdsRef, drawModeRef }),
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

    // (MapLibre keeps its own ResizeObserver on the container, so no manual
    // resize handling is needed here — the root fills the viewport via CSS.)

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
        loadLabelLayers(map, basemap.overlay).then(() => {
          bringLabelsToTop(map);
          bringStudyareaToTop(map);
          onLabelsReady?.(map);
        });
      }
      onLoad?.();
    }

    // Basemap swap: changing `basemapId` re-points the <Map mapStyle> prop, which
    // makes react-map-gl call setStyle() and reload the base — wiping the
    // appended overlay (labels/roads/water) and any imperative MVT/COG layers.
    // Wait for the new style to finish, then re-append the overlay and let App
    // re-sync its imperative layers via onLabelsReady. Deck's interleaved overlay
    // re-syncs its own layers automatically on styledata.
    useEffect(() => {
      if (appliedBasemapRef.current === basemap.id) return;
      const map = mapRef.current?.getMap();
      if (!map) return;

      function onStyleReady() {
        if (!map || !map.isStyleLoaded()) return;
        map.off("idle", onStyleReady);
        // The old overlay layers are gone with the previous style — clear the
        // tag so loadLabelLayers re-adds them for the new base.
        delete (map as LabelTaggedMap).__labelLayerIds;
        (map as LabelTaggedMap).__studyareaLayerIds = (topLayers ?? []).map((l) => l.id);
        loadLabelLayers(map, basemap.overlay).then(() => {
          bringLabelsToTop(map);
          bringStudyareaToTop(map);
          onLabelsReady?.(map);
        });
        appliedBasemapRef.current = basemap.id;
      }

      map.on("idle", onStyleReady);
      return () => {
        map.off("idle", onStyleReady);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [basemap.id]);

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
        mapStyle={basemap.base}
        dragRotate={false}
        pitchWithRotate={false}
        onLoad={handleLoad}
        onMove={onMove}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
      >
        <DeckGLOverlay
          layers={topLayers && topLayers.length > 0 ? [...layers, ...topLayers] : layers}
          overlayRef={overlayRef}
          hoverRef={hoverRef}
          mvtHoverRef={mvtHoverRef}
          clickableIdsRef={clickableIdsRef}
          drawModeRef={drawModeRef}
        />
      </Map>
    );
  },
);
