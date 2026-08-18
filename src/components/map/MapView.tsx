import { onMount, onCleanup, createEffect, createSignal, type JSX } from "solid-js";
// MapLibre 6 is ESM-only and has no default export — everything is imported by
// name. (In v5 this was `maplibregl.addProtocol`, `new maplibregl.Map`, ...)
import { Map as MapLibreMap, addProtocol, setWorkerUrl } from "maplibre-gl";
import type { LayerSpecification, ErrorEvent } from "maplibre-gl";
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
import type {
  MapViewHandle,
  MapLayerMouseEvent,
  ViewState,
  ViewStateChangeEvent,
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

// Types are re-exported so existing `import type { ViewState } from ".../MapView"`
// sites keep working.
export type { ViewState, Basemap, MapViewHandle } from "./map-view-config";

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
  // the style, so setStyle() does not run and the previous overlay's layers are
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

interface MapViewProps {
  /** Selected background basemap; changing it swaps only the base style. */
  basemapId?: string;
  style?: JSX.CSSProperties;
  /** Controlled camera. When omitted the map keeps its own uncontrolled camera. */
  viewState?: ViewState;
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
   *
   * Constructor-only: MapLibre reads the context attributes once, so this
   * cannot be toggled after mount.
   */
  preserveDrawingBuffer?: boolean;
  /** Receives the handle once the map exists. */
  ref?: (handle: MapViewHandle) => void;
}

export function MapView(props: MapViewProps): JSX.Element {
  const [map, setMap] = createSignal<MapLibreMap | null>(null);
  const [drawMode, setDrawMode] = createSignal(false);

  let container!: HTMLDivElement;
  // The basemap applied on the last completed (re)load — used to detect a swap.
  let appliedBasemapId = "";
  // Ids of the overlay layers currently in the stack, so a swap that keeps the
  // same base style (the "met labels" pairs) can remove the ones it drops.
  let appliedOverlayIds: string[] = [];
  // Set while the controlled-camera effect drives the map, so the `move` events
  // jumpTo fires synchronously are not reported back through onMove. Both panes
  // share one `viewState` and both report onMove, so without this each pane's
  // echo would re-drive the other and the two would never settle.
  let applyingCamera = false;

  function currentBasemap() {
    return basemapById(props.basemapId ?? DEFAULT_BASEMAP_ID);
  }

  function applyOverlay(instance: MapLibreMap, overlayUrl: string | undefined, id: string) {
    // async continuation; calling the
    // CURRENT onLabelsReady when the overlay lands is exactly what is wanted
    // eslint-disable-next-line solid/reactivity
    ensureAnchorsAndOverlay(instance, overlayUrl, appliedOverlayIds).then((ids) => {
      appliedOverlayIds = ids;
      appliedBasemapId = id;
      props.onLabelsReady?.(instance);
    });
  }

  onMount(() => {
    const basemap = currentBasemap();
    const camera = props.viewState ?? INITIAL_VIEW_STATE;
    const instance = new MapLibreMap({
      container,
      style: basemap.base,
      center: [camera.longitude, camera.latitude],
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
      dragRotate: false,
      pitchWithRotate: false,
      // Run collision detection per source rather than in one global arena,
      // so a layer's icons only thin against their own. Since tileSourceId
      // keys each layer's source on its config id (`pmtiles-source-<id>`),
      // one-source-per-collision-group is effectively one *layer* per group:
      // switching `apotheek` on can no longer suppress `huisarts` icons.
      // Constructor-only — MapLibre reads it once, so it cannot be toggled
      // at runtime without recreating the map.
      crossSourceCollisions: false,
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
      zoomLevelsToOverscale: undefined,
      // The default bottom-right attribution control is replaced by the
      // app's own info button (MapAttribution in App.tsx).
      attributionControl: false,
      // MapLibre 5 takes GL context flags via canvasContextAttributes.
      canvasContextAttributes: props.preserveDrawingBuffer
        ? { preserveDrawingBuffer: true }
        : undefined,
    });

    appliedBasemapId = basemap.id;

    // Keep the anchors present for the whole map lifetime. A basemap swap calls
    // setStyle(), which wipes them — and the anchors ARE the z-order mechanism
    // (`anchorForConfig`), so every imperative re-add that follows needs them
    // back first. A missing anchor is not fatal (each add falls back to
    // appending, see `addMvtLayer`) but it silently lands the layer in the
    // wrong band, which is a far more confusing bug than a throw.
    //
    // Readiness check: deliberately NOT `map.isStyleLoaded()`. That also waits
    // for sources and sprites, while `addLayer` only needs the style JSON
    // itself (`style._loaded`) — the stricter guard would skip creating the
    // anchors in exactly the window where the first layers want them.
    instance.on("styledata", () => {
      if (!instance.style) return;
      const styleLoaded = (instance.style as unknown as { _loaded?: boolean })._loaded;
      if (styleLoaded) ensureAnchors(instance);
    });

    // MapLibre event handler; see the
    // note on the pointer handlers below
    // eslint-disable-next-line solid/reactivity
    instance.on("load", () => {
      applyOverlay(instance, currentBasemap().overlay, currentBasemap().id);
      props.onLoad?.();
    });

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
    instance.on("error", (evt: ErrorEvent) => {
      const sourceId = (evt as { sourceId?: string }).sourceId;
      console.error(
        `MapLibre error${sourceId ? ` [source: ${sourceId}]` : ""}:`,
        evt.error ?? evt,
      );
    });

    // Forward the pointer and camera events the app listens for. Reading
    // `props.*` inside the handler (rather than capturing it) keeps a later
    // prop change live without re-registering the listener.
    /* eslint-disable solid/reactivity -- MapLibre event handlers, not Solid
       tracking scopes; reading props at dispatch time is the point */
    instance.on("move", () => {
      if (applyingCamera) return;
      const centre = instance.getCenter();
      props.onMove?.({
        viewState: {
          longitude: centre.lng,
          latitude: centre.lat,
          zoom: instance.getZoom(),
          pitch: instance.getPitch(),
          bearing: instance.getBearing(),
        },
      });
    });
    instance.on("click", (evt) => props.onClick?.(evt));
    instance.on("mousemove", (evt) => props.onMouseMove?.(evt));
    instance.on("mousedown", (evt) => props.onMouseDown?.(evt));
    instance.on("mouseup", (evt) => props.onMouseUp?.(evt));
    /* eslint-enable solid/reactivity */

    setMap(instance);
    props.ref?.({ map, drawMode, setDrawMode });

    onCleanup(() => {
      setMap(null);
      instance.remove();
    });
  });

  // (MapLibre keeps its own ResizeObserver on the container, so no manual
  // resize handling is needed here — the root fills the viewport via CSS.)
  //
  // Note: there is no "re-hoist layers on every change" effect. The anchor
  // layers give each added layer a stable `beforeId`, so `addLayer` places
  // everything in the right band natively — no post-hoc moveLayer shuffling.

  onMount(() => {
    function onFlyTo(e: Event) {
      const { latitude, longitude, zoom } = (e as CustomEvent).detail;
      map()?.flyTo({ center: [longitude, latitude], zoom: zoom ?? 12 });
    }
    window.addEventListener("map:flyto", onFlyTo);
    onCleanup(() => window.removeEventListener("map:flyto", onFlyTo));
  });

  // Controlled camera: follow `viewState` when the parent drives it. This is
  // what keeps the two panes in sync — both are handed the same `viewState` and
  // both report `onMove`, so a drag on either moves the other.
  //
  // The pane that originated the move is already at exactly these coordinates
  // (they came out of its own getCenter/getZoom), so the equality check skips
  // it and only the other pane actually jumps. That check is an optimisation,
  // not the loop guard — `applyingCamera` is.
  createEffect(() => {
    const camera = props.viewState;
    const instance = map();
    if (!camera || !instance) return;
    const centre = instance.getCenter();
    const samePosition =
      centre.lng === camera.longitude &&
      centre.lat === camera.latitude &&
      instance.getZoom() === camera.zoom &&
      instance.getPitch() === camera.pitch &&
      instance.getBearing() === camera.bearing;
    if (samePosition) return;
    // jumpTo fires movestart/move/moveend synchronously, so the flag is back
    // down before anything else can observe it.
    applyingCamera = true;
    instance.jumpTo({
      center: [camera.longitude, camera.latitude],
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
    });
    applyingCamera = false;
  });

  // Basemap swap. Changing `basemapId` calls setStyle(), which reloads the base
  // — wiping the anchors, the appended overlay (labels/roads/water), and any
  // imperative MVT/COG layers. Wait for the new style to finish, then re-add the
  // anchors + overlay and let App re-sync its imperative layers via
  // onLabelsReady.
  //
  // Two basemaps can share a base style and differ only in their overlay (the
  // "met labels" pairs). Then the style does NOT change, so setStyle() must not
  // run and no further `idle` is guaranteed to arrive — waiting for one would
  // hang and the overlay would never be swapped. Detect that case and apply the
  // overlay immediately instead.
  createEffect(() => {
    const basemap = currentBasemap();
    const instance = map();
    if (!instance) return;
    if (appliedBasemapId === basemap.id) return;

    const previous = basemapById(appliedBasemapId);
    if (previous.base === basemap.base) {
      applyOverlay(instance, basemap.overlay, basemap.id);
      return;
    }

    function onStyleReady() {
      if (!instance || !instance.isStyleLoaded()) return;
      instance.off("idle", onStyleReady);
      applyOverlay(instance, basemap.overlay, basemap.id);
    }

    instance.on("idle", onStyleReady);
    instance.setStyle(basemap.base);
    onCleanup(() => instance.off("idle", onStyleReady));
  });

  // Cursors are MapLibre's own: it sets grab/grabbing on the canvas for
  // drag-pan as long as nothing overwrites `canvas.style.cursor`. The two
  // app-specific cursors are written imperatively elsewhere — pointer over a
  // clickable feature (use-hover-cursor.ts) and crosshair while a draw tool
  // is armed (App). Both restore `""` rather than "grab", which is what hands
  // control back to MapLibre's stylesheet.

  return <div ref={container} style={props.style ?? { width: "100%", height: "100%" }} />;
}
