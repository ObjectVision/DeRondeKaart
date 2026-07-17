import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
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
 * (labels, roads, water — inserted into the overlay band by ensureAnchorsAndOverlay).
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

/** Fetch an overlay style's layer specs (or null on failure). */
async function fetchOverlayLayers(overlayUrl: string): Promise<LayerSpecification[] | null> {
  const resp = await fetch(overlayUrl);
  if (!resp.ok) {
    console.warn(`Failed to load labels style: ${resp.statusText}`);
    return null;
  }
  const style = (await resp.json()) as { layers: LayerSpecification[] };
  return style.layers;
}

/**
 * Ensure all anchors + the basemap overlay are present, in the correct
 * interleaving. The overlay style is fetched FIRST, then anchors and overlay
 * layers are added in a single synchronous burst — so `overlay-layers` is
 * guaranteed to exist when the overlay layers reference it as `beforeId` (the
 * `await` used to sit between anchor creation and overlay insertion, letting a
 * concurrent setStyle diff wipe the anchors mid-flight → "non-existing layer"
 * errors on a basemap swap). Safe to call on initial load and after a swap.
 * Deck's interleaved layers re-sync against the anchors automatically.
 */
async function ensureAnchorsAndOverlay(map: MapLibreMap, overlayUrl: string) {
  const overlayLayers = await fetchOverlayLayers(overlayUrl);
  // Synchronous from here — no await splits the anchor/overlay insertion.
  ensureAnchors(map);
  if (!overlayLayers) return;
  for (const layer of overlayLayers) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer, ANCHORS.overlay);
  }
}

function DeckGLOverlay(props: {
  layers: Layer[];
  overlayRef: React.RefObject<MapboxOverlay | null>;
  hoverRef: React.RefObject<boolean>;
  mvtHoverRef: React.RefObject<boolean>;
  clickableIdsRef: React.RefObject<string[]>;
  drawModeRef: React.RefObject<boolean>;
  panningRef: React.RefObject<boolean>;
}) {
  const { hoverRef, mvtHoverRef, clickableIdsRef, drawModeRef, panningRef } = props;
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
        // crosshair while the area-select tool is armed. `isDragging` only covers
        // deck's own drags — MapLibre handles drag-pan, tracked via panningRef.
        getCursor: ({ isDragging }) =>
          drawModeRef.current
            ? "crosshair"
            : isDragging || panningRef.current
              ? "grabbing"
              : hoverRef.current || mvtHoverRef.current
                ? "pointer"
                : "grab",
      }),
  );
  props.overlayRef.current = overlay;
  // Push layers in an effect, not the render body: onMove re-renders this
  // component ~60×/sec during a pan, and setProps → deck's full layer-diff pass
  // is not free even when every layer instance is identical.
  const { layers } = props;
  useEffect(() => {
    overlay.setProps({ layers });
  }, [overlay, layers]);
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
  /**
   * Keep the WebGL drawing buffer readable after rendering (small perf cost).
   * Set by the export-preview map so PNG capture can read the canvas at idle
   * — including deck.gl's interleaved draws — instead of racing a render
   * event. Leave off for the main maps.
   */
  preserveDrawingBuffer?: boolean;
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  function MapView({ layers, topLayers, basemapId, style, viewState, onMove, onClick, onMouseMove, onMouseDown, onMouseUp, onLoad, onLabelsReady, preserveDrawingBuffer }, ref) {
    const mapRef = useRef<MapRef>(null);
    const overlayRef = useRef<MapboxOverlay | null>(null);
    const hoverRef = useRef<boolean>(false);
    const mvtHoverRef = useRef<boolean>(false);
    const clickableIdsRef = useRef<string[]>([]);
    const drawModeRef = useRef<boolean>(false);
    const panningRef = useRef<boolean>(false);
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
        const { latitude, longitude, zoom } = (e as CustomEvent).detail;
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: zoom ?? 12 });
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

    // Keep the anchors present for the whole map lifetime. A basemap swap calls
    // setStyle(), which wipes the anchors; deck.gl's own `styledata` handler then
    // re-resolves its interleaved layers and calls `map.addLayer(layer, beforeId)`
    // — which THROWS if the `beforeId` anchor isn't in the style yet. So we must
    // recreate the anchors on `styledata` too, before deck's handler runs a resolve
    // against a missing anchor. This is wired via the <Map onStyleData> prop (not a
    // manual map.on in an effect): react-map-gl registers its event forwarding when
    // the map instance is created — before useControl adds the deck overlay — so it
    // works for a late-mounting map (the right map, whose maplibre instance doesn't
    // exist yet when a mount effect would try to attach a listener) AND runs before
    // deck's styledata handler on the same event. `ensureAnchors` is guarded
    // per-anchor (skips ones already present), so the `styledata` it re-fires is a
    // no-op → no feedback loop.
    // Readiness check: deliberately NOT `map.isStyleLoaded()`. That also waits for
    // sources/sprites, but maplibre's `addLayer` (and deck's resolve) only require
    // the style JSON itself (`style._loaded`). On the right map — which mounts with
    // deck layers already queued — deck resolves in that window where `_loaded` is
    // true but `isStyleLoaded()` is false, so an isStyleLoaded guard would skip
    // creating the anchors exactly when deck needs them.
    function handleStyleData() {
      const map = mapRef.current?.getMap();
      if (!map || !map.style) return;
      const styleLoaded = (map.style as unknown as { _loaded?: boolean })._loaded;
      if (styleLoaded) ensureAnchors(map);
    }

    // MapLibre drag-pan (deck's `isDragging` only tracks deck's own drags):
    // flip panningRef for getCursor and set the canvas cursor directly — deck
    // suspends hover picking during a drag, so getCursor alone may not re-run
    // until the next mousemove after the drag ends.
    function handleDragStart() {
      panningRef.current = true;
      const canvas = mapRef.current?.getMap().getCanvas();
      if (canvas && !drawModeRef.current) canvas.style.cursor = "grabbing";
    }

    function handleDragEnd() {
      panningRef.current = false;
      const canvas = mapRef.current?.getMap().getCanvas();
      if (canvas && !drawModeRef.current) {
        canvas.style.cursor =
          hoverRef.current || mvtHoverRef.current ? "pointer" : "grab";
      }
    }

    function handleLoad() {
      const map = mapRef.current?.getMap();
      if (map) {
        ensureAnchorsAndOverlay(map, basemap.overlay).then(() => {
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

    // Stable merged array — building it inline would hand DeckGLOverlay a new
    // array (→ a full deck setProps diff) on every view-state render.
    const overlayLayers = useMemo(
      () => (topLayers && topLayers.length > 0 ? [...layers, ...topLayers] : layers),
      [layers, topLayers],
    );

    return (
      <Map
        ref={mapRef}
        {...mapProps}
        style={style ?? { width: "100%", height: "100%" }}
        mapStyle={basemap.base}
        dragRotate={false}
        pitchWithRotate={false}
        // The default bottom-right attribution control is replaced by the
        // app's own info button (MapAttribution in App.tsx).
        attributionControl={false}
        // MapLibre 5 takes GL context flags via canvasContextAttributes.
        canvasContextAttributes={
          preserveDrawingBuffer ? { preserveDrawingBuffer: true } : undefined
        }
        onLoad={handleLoad}
        onStyleData={handleStyleData}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onMove={onMove}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
      >
        <DeckGLOverlay
          layers={overlayLayers}
          overlayRef={overlayRef}
          hoverRef={hoverRef}
          mvtHoverRef={mvtHoverRef}
          clickableIdsRef={clickableIdsRef}
          drawModeRef={drawModeRef}
          panningRef={panningRef}
        />
      </Map>
    );
  },
);
