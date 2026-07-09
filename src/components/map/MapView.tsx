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

/**
 * Named invisible anchor layers that partition the maplibre stack into z-order
 * bands. Every added layer sets its `beforeId` to one of these so both deck.gl
 * (interleaved) and native `map.addLayer` place it in the right band without any
 * after-the-fact `moveLayer` shuffling. Bottom → top:
 *
 *   basemap background layers
 *   [background-layers]
 *   normal added layers            → beforeid: "map-layers" (default)
 *   [map-layers]
 *   basemap overlay layers (labels/roads/water)
 *   [overlay-layers]
 *   foreground added layers        → beforeid: "foreground-layers"
 *   [foreground-layers]
 *   study area                     → beforeid: "studyarea-layers"
 *   [studyarea-layers]
 *   click marker / selection box   → no beforeId (topmost of all)
 *
 * `beforeId: X` inserts the layer in the band BELOW anchor X. A layer sets its
 * band per-config via `beforeid` (see anchorForConfig).
 */
export const ANCHORS = {
  background: "background-layers",
  map: "map-layers",
  overlay: "overlay-layers",
  foreground: "foreground-layers",
  studyarea: "studyarea-layers",
} as const;

/** Anchor ids as a set, for validating a config's `beforeid`. */
const ANCHOR_IDS = new Set<string>(Object.values(ANCHORS));

/**
 * The anchor a layer should sit below. Reads the config's `beforeid` (an anchor
 * id); defaults to `map-layers` (below the label overlay). Warns and falls back
 * to the default if `beforeid` names something that isn't a known anchor.
 */
export function anchorForConfig(config: { beforeid?: string }): string {
  const b = config.beforeid;
  if (!b) return ANCHORS.map;
  if (ANCHOR_IDS.has(b)) return b;
  console.warn(`layers.json: unknown beforeid "${b}"; using "${ANCHORS.map}"`);
  return ANCHORS.map;
}

/** Anchors in bottom→top order. */
const ANCHOR_ORDER = [
  ANCHORS.background,
  ANCHORS.map,
  ANCHORS.overlay,
  ANCHORS.foreground,
  ANCHORS.studyarea,
];

/**
 * Add all four anchors, contiguous at the top of the current stack and in the
 * correct bottom→top order. Idempotent. Adding them all up front (before the
 * overlay) means every anchor exists from the first deck sync, so deck layers
 * resolve into the right band immediately — no dependency on load timing.
 */
function ensureAnchors(map: MapLibreMap) {
  for (const id of ANCHOR_ORDER) {
    if (map.getLayer(id)) continue;
    map.addLayer({ id, type: "background", layout: { visibility: "none" } });
  }
}

/**
 * Fetch the overlay style and add its label/road/water layers into the overlay
 * band — inserted before the `overlay-layers` anchor so they sit above
 * `map-layers` and below `overlay-layers`. Idempotent per map+overlay set.
 */
async function loadLabelLayers(map: MapLibreMap, overlayUrl: string) {
  const resp = await fetch(overlayUrl);
  if (!resp.ok) {
    console.warn(`Failed to load labels style: ${resp.statusText}`);
    return;
  }
  const style = (await resp.json()) as { layers: LayerSpecification[] };
  for (const layer of style.layers) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer, ANCHORS.overlay);
  }
}

/**
 * Ensure all four anchors + the basemap overlay are present, in the correct
 * interleaving. Anchors go in first (so they exist before any deck sync), then
 * the overlay is inserted into the overlay band. Safe to call on initial load
 * and after a basemap swap (setStyle wipes anchors + overlay). Deck's
 * interleaved layers re-sync against the anchors automatically.
 */
async function ensureAnchorsAndOverlay(map: MapLibreMap, overlayUrl: string) {
  ensureAnchors(map);
  await loadLabelLayers(map, overlayUrl);
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
  /**
   * Always-on-top layers (study area, click marker, selection box). They carry
   * no `beforeId`, so deck appends them above the `foreground-layers` anchor —
   * i.e. above everything else.
   */
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
    //
    // Note: there is no longer a "re-hoist layers on every change" effect. The
    // anchor layers give each added layer a stable `beforeId`, so deck.gl
    // (interleaved) and native addLayer place everything in the right band
    // natively — no post-hoc moveLayer shuffling needed.


    // Force deck's interleaved overlay to re-resolve layer order against the
    // current maplibre stack. Deck re-resolves on `styledata` and on prop
    // changes, but a burst of synchronous addLayer calls (anchors + overlay) can
    // land without a clean re-resolve afterwards — leaving a deck layer added
    // before the anchors existed stranded in the wrong band. Re-setting the same
    // layers array forces `_resolveLayers` to run once the anchors are in place.
    //
    // Deferred to the next frame and skipped when there are no deck layers, so it
    // never re-diffs (which can dispose/recreate layer GL programs) inside or
    // racing an in-flight draw pass.
    function forceDeckResolve() {
      requestAnimationFrame(() => {
        const overlay = overlayRef.current;
        const current = getDeckLayers(overlayRef);
        if (overlay && current.length > 0) overlay.setProps({ layers: current });
      });
    }

    function handleLoad() {
      const map = mapRef.current?.getMap();
      if (map) {
        ensureAnchorsAndOverlay(map, basemap.overlay).then(() => {
          forceDeckResolve();
          onLabelsReady?.(map);
        });
      }
      onLoad?.();
    }

    // Basemap swap: changing `basemapId` re-points the <Map mapStyle> prop, which
    // makes react-map-gl call setStyle() and reload the base — wiping the anchors,
    // the appended overlay (labels/roads/water), and any imperative MVT/COG layers.
    // Wait for the new style to finish, then re-add the anchors + overlay and let
    // App re-sync its imperative layers via onLabelsReady. Deck's interleaved
    // overlay re-syncs its own layers against the anchors automatically.
    useEffect(() => {
      if (appliedBasemapRef.current === basemap.id) return;
      const map = mapRef.current?.getMap();
      if (!map) return;

      function onStyleReady() {
        if (!map || !map.isStyleLoaded()) return;
        map.off("idle", onStyleReady);
        ensureAnchorsAndOverlay(map, basemap.overlay).then(() => {
          forceDeckResolve();
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
