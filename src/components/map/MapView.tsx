import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Map } from "react-map-gl/maplibre";
import type {
  MapRef,
  ViewStateChangeEvent,
  MapLayerMouseEvent,
  ErrorEvent,
} from "react-map-gl/maplibre";
// MapLibre 6 is ESM-only and has no default export — `addProtocol` is imported
// by name. (In v5 this was `maplibregl.addProtocol`.)
import { addProtocol, setWorkerUrl } from "maplibre-gl";
import type { Map as MapLibreMap, LayerSpecification } from "maplibre-gl";
// MapLibre 6 splits the worker into its own ESM file and locates it with
// `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Vite's dependency
// optimizer rewrites the maplibre entry into `.vite/deps/`, where that sibling
// does not exist — the worker 404s, no tile is ever parsed, and the style
// never finishes loading (a silent blank map, not an error). In v5 the worker
// was inlined, so this had no equivalent.
//
// `?worker&url` — NOT a bare `?url`. The worker itself imports
// `./maplibre-gl-shared.mjs`; `?url` copies the single file and leaves that
// import dangling, so in a production build the worker boots and dies
// instantly (again silently — the map just never renders). `?worker` makes
// Vite bundle the worker with its dependencies, and `&url` yields the string
// `setWorkerUrl` wants rather than a constructor.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import { Protocol as PmtilesProtocol } from "pmtiles";
import { registerScoreProtocol } from "@/layers/score-protocol";
import {
  ANCHORS,
  ANCHOR_ORDER,
  DEFAULT_BASEMAP_ID,
  INITIAL_VIEW_STATE,
  basemapById,
} from "./map-view-config";
import "maplibre-gl/dist/maplibre-gl.css";

// Point MapLibre at its worker before any map is constructed (see import).
setWorkerUrl(maplibreWorkerUrl);

// Register COG protocol once
addProtocol("cog", cogProtocol);

// Register the PMTiles protocol once. A PMTiles archive is a single file read
// with HTTP Range requests; the protocol turns MapLibre's {z}/{x}/{y} tile
// requests into range reads against it, so a `pmtiles://` source otherwise
// behaves exactly like a normal vector source.
const pmtilesProtocol = new PmtilesProtocol();
addProtocol("pmtiles", pmtilesProtocol.tile);

// Register the in-memory score-grid protocol ("Lagen combineren"). It has to be
// in place before any `cogmem://` source is added — MapLibre falls back to a
// plain fetch for an unregistered scheme, which fails with "URL scheme not
// supported" — and a combination can be created as soon as the map is up.
registerScoreProtocol();

// Types are re-exported (type-only re-exports don't affect Fast Refresh) so
// existing `import type { ViewState } from ".../MapView"` sites keep working.
export type { ViewState, Basemap } from "./map-view-config";

/**
 * Add all four anchors, contiguous at the top of the current stack and in the
 * correct bottom→top order. Idempotent. Adding them all up front means every
 * anchor exists before any layer targets it as a `beforeId`, so layers resolve
 * into the right band immediately — no dependency on load timing.
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
 *
 * A basemap without an overlay (the bare "no labels" variants) still needs the
 * anchors: every added layer's `beforeId` targets one, so skipping them would
 * break layer insertion entirely, not just the labels.
 */
async function ensureAnchorsAndOverlay(
  map: MapLibreMap,
  overlayUrl?: string,
  staleOverlayIds?: string[],
): Promise<string[]> {
  const overlayLayers = overlayUrl ? await fetchOverlayLayers(overlayUrl) : null;
  // Synchronous from here — no await splits the anchor/overlay insertion.
  ensureAnchors(map);
  // Two basemaps can share a base style and differ only in their overlay (the
  // option combinations of one base). Switching between those never re-points
  // `mapStyle`, so setStyle() does not fire and the previous overlay's layers are
  // still in the stack — clear them, or turning an option off leaves them drawn.
  // Remove ALL of the previous overlay's layers, including the ones the new
  // overlay also contains. Keeping a shared layer in place would keep its OLD
  // stack position while everything else is appended above it: stepping from
  // "labels" to "labels + wegen" left positron's `water_name` stranded below all
  // 26 road layers, drawing the water label under the roads. Re-adding it in the
  // new overlay's order is what makes the file's order authoritative.
  for (const id of staleOverlayIds ?? []) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (!overlayLayers) return [];
  for (const layer of overlayLayers) {
    // A layer the BASE style already owns is not ours to move or duplicate.
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer, ANCHORS.overlay);
  }
  return overlayLayers.map((l) => l.id);
}

export interface MapViewHandle {
  mapRef: React.RefObject<MapRef | null>;
  /** Live flag: the area-select draw mode is armed (crosshair cursor). */
  drawModeRef: React.RefObject<boolean>;
}


interface MapViewProps {
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
  function MapView({ basemapId, style, viewState, onMove, onClick, onMouseMove, onMouseDown, onMouseUp, onLoad, onLabelsReady, preserveDrawingBuffer }, ref) {
    const mapRef = useRef<MapRef>(null);
    const drawModeRef = useRef<boolean>(false);
    const basemap = basemapById(basemapId ?? DEFAULT_BASEMAP_ID);
    // The basemap applied on the last completed (re)load — used to detect a swap.
    const appliedBasemapRef = useRef<string>(basemap.id);
    // Ids of the overlay layers currently in the stack, so a swap that keeps the
    // same base style (the "met labels" pairs) can remove the ones it drops.
    const appliedOverlayIdsRef = useRef<string[]>([]);

    useImperativeHandle(ref, () => ({ mapRef, drawModeRef }), []);

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
    // Note: there is no "re-hoist layers on every change" effect. The anchor
    // layers give each added layer a stable `beforeId`, so `addLayer` places
    // everything in the right band natively — no post-hoc moveLayer shuffling.

    // Keep the anchors present for the whole map lifetime. A basemap swap calls
    // setStyle(), which wipes them — and the anchors ARE the z-order mechanism
    // (`anchorForConfig`), so every imperative re-add that follows needs them
    // back first. A missing anchor is not fatal (each add falls back to
    // appending, see `addMvtLayer`) but it silently lands the layer in the
    // wrong band, which is a far more confusing bug than a throw.
    //
    // Wired via the <Map onStyleData> prop rather than a manual map.on in an
    // effect: react-map-gl registers its event forwarding when the map instance
    // is created, so this also works for a late-mounting map (the right map,
    // whose maplibre instance doesn't exist yet when a mount effect would try
    // to attach a listener). `ensureAnchors` is guarded per-anchor, so the
    // `styledata` it re-fires is a no-op → no feedback loop.
    //
    // Readiness check: deliberately NOT `map.isStyleLoaded()`. That also waits
    // for sources and sprites, while `addLayer` only needs the style JSON
    // itself (`style._loaded`) — the stricter guard would skip creating the
    // anchors in exactly the window where the first layers want them.
    function handleStyleData() {
      const map = mapRef.current?.getMap();
      if (!map || !map.style) return;
      const styleLoaded = (map.style as unknown as { _loaded?: boolean })._loaded;
      if (styleLoaded) ensureAnchors(map);
    }

    // Cursors are MapLibre's own: it sets grab/grabbing on the canvas for
    // drag-pan as long as nothing overwrites `canvas.style.cursor`. The two
    // app-specific cursors are written imperatively elsewhere — pointer over a
    // clickable feature (use-hover-cursor.ts) and crosshair while a draw tool
    // is armed (App). Both restore `""` rather than "grab", which is what hands
    // control back to MapLibre's stylesheet.

    function handleLoad() {
      const map = mapRef.current?.getMap();
      if (map) {
        ensureAnchorsAndOverlay(map, basemap.overlay, appliedOverlayIdsRef.current).then((ids) => {
          appliedOverlayIdsRef.current = ids;
          onLabelsReady?.(map);
        });
      }
      onLoad?.();
    }

    /**
     * MapLibre's own failures — tile fetches, style JSON, source loads, missing
     * sprite images — are otherwise swallowed: without a listener they go to
     * MapLibre's default handler and are easy to miss entirely. Two blank-map
     * regressions during the v6 upgrade produced *no* console output at all,
     * which is exactly what this exists to prevent.
     *
     * Deliberately log-only. A tile 404 on one source is not worth surfacing to
     * a user mid-session, and retry policy belongs to the loaders, not here.
     * `sourceId` is present on source-related errors and is usually the single
     * most useful field for working out which layer is at fault.
     */
    function handleError(evt: ErrorEvent) {
      const sourceId = (evt as { sourceId?: string }).sourceId;
      console.error(
        `MapLibre error${sourceId ? ` [source: ${sourceId}]` : ""}:`,
        evt.error ?? evt,
      );
    }

    // Basemap swap: changing `basemapId` re-points the <Map mapStyle> prop, which
    // makes react-map-gl call setStyle() and reload the base — wiping the anchors,
    // the appended overlay (labels/roads/water), and any imperative MVT/COG layers.
    // Wait for the new style to finish, then re-add the anchors + overlay and let
    // App re-sync its imperative layers via onLabelsReady. Deck's interleaved
    // overlay re-syncs its own layers against the anchors automatically.
    //
    // Two basemaps can share a base style and differ only in their overlay (the
    // "met labels" pairs). Then `mapStyle` does NOT change, so setStyle() never
    // runs and no further `idle` is guaranteed to arrive — waiting for one would
    // hang and the overlay would never be swapped. Detect that case and apply the
    // overlay immediately instead.
    useEffect(() => {
      if (appliedBasemapRef.current === basemap.id) return;
      const map = mapRef.current?.getMap();
      if (!map) return;

      const previous = basemapById(appliedBasemapRef.current);
      const baseUnchanged = previous.base === basemap.base;

      function applyOverlay() {
        if (!map) return;
        ensureAnchorsAndOverlay(map, basemap.overlay, appliedOverlayIdsRef.current).then((ids) => {
          appliedOverlayIdsRef.current = ids;
          onLabelsReady?.(map);
        });
        appliedBasemapRef.current = basemap.id;
      }

      if (baseUnchanged) {
        applyOverlay();
        return;
      }

      function onStyleReady() {
        if (!map || !map.isStyleLoaded()) return;
        map.off("idle", onStyleReady);
        applyOverlay();
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
        // Run collision detection per source rather than in one global arena,
        // so a layer's icons only thin against their own. Since tileSourceId
        // keys each layer's source on its config id (`pmtiles-source-<id>`),
        // one-source-per-collision-group is effectively one *layer* per group:
        // switching `apotheek` on can no longer suppress `huisarts` icons.
        // Constructor-only — MapLibre reads it once, so it cannot be toggled
        // at runtime without recreating the map.
        crossSourceCollisions={false}
        // Keep MapLibre 5's overscaling behaviour. v6 defaults this to 4,
        // which splits tiles between a source's maxzoom and the top 4 zoom
        // levels instead of overscaling them — and, per MapLibre's own docs,
        // "changes the results of query rendered features".
        //
        // That is not academic here: ALL picking (feature info, hover cursor,
        // marker snap, annotation select/drag) goes through
        // queryRenderedFeatures, and the PMTiles archives cap at z12-z14 while
        // users routinely zoom past z16. Measured on the v6 default, `line`
        // layers from z12 archives became rendered-but-unpickable above their
        // cap — cbsgemeente2026 from z14 up, cbswijk2026 from z17 up — while
        // fill and symbol layers were unaffected. Setting this back to
        // undefined restores picking at every zoom.
        //
        // Revisit only alongside re-tiling the archives to deeper maxzooms.
        zoomLevelsToOverscale={undefined}
        // The default bottom-right attribution control is replaced by the
        // app's own info button (MapAttribution in App.tsx).
        attributionControl={false}
        // MapLibre 5 takes GL context flags via canvasContextAttributes.
        canvasContextAttributes={
          preserveDrawingBuffer ? { preserveDrawingBuffer: true } : undefined
        }
        onLoad={handleLoad}
        onError={handleError}
        onStyleData={handleStyleData}
        onMove={onMove}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
      />
    );
  },
);
