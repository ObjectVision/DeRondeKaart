import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type {
  MapAccessor,
  MapViewHandle,
  ViewState,
  ViewStateChangeEvent,
} from "@/components/map/map-view-config";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MapView } from "@/components/map/MapView";
import { useMapLayers, type LayerEntry } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import {
  useFilteredStudyAreaLayers,
  type FilteredStudyArea,
} from "@/hooks/use-filtered-study-area";
import { useAnnotationSource } from "@/hooks/use-annotation-source";
import type { Annotation } from "@/types/annotation";

export interface ExportPreviewHandle {
  /** The preview's raw MapLibre map (null until loaded). */
  getMap(): MapLibreMap | null;
}

interface ExportPreviewMapProps {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
  hiddenRules: globalThis.Map<string, Set<string>>;
  basemapId: string;
  studyAreaId?: string;
  /** Gebiedsfilter-driven studyarea; replaces the configured one when set. */
  filteredStudy?: FilteredStudyArea | null;
  /** Annotations to draw on the export (empty/omitted = none). */
  annotations?: Annotation[];
  initialViewState: ViewState;
  ref?: (handle: ExportPreviewHandle) => void;
}

/**
 * The circular export preview: a third MapView instance that mirrors the main
 * map's layers so the user can fine-tune the PNG framing without disturbing
 * the live map. Sources and layers belong to a map's own style, so this
 * component replays the source entries into its own useMapLayers().
 */
export function ExportPreviewMap(props: ExportPreviewMapProps): JSX.Element {
  const [mapView, setMapView] = createSignal<MapViewHandle | null>(null);
  const getMap: MapAccessor = () => mapView()?.map() ?? null;
  const layers = useMapLayers(getMap);

  // Same swap as the main maps: a gebiedsfilter selection replaces the
  // configured studyarea (skip loading it entirely — the dialog is a per-open
  // snapshot, so the choice never flips while mounted). Native MapLibre layers
  // on this map's own style, re-added by handleLabelsReady.
  const studyArea = useStudyAreaLayer(
    () => (props.filteredStudy ? undefined : props.studyAreaId),
    mapView,
  );
  const filteredStudyOverlay = useFilteredStudyAreaLayers(
    () => props.filteredStudy ?? null,
    mapView,
  );
  const [viewState, setViewState] = createSignal<ViewState>(props.initialViewState);

  // Annotations on the export: native MapLibre sources on this map's own
  // style, static view — no draft, selection, or peers (so no drag handles
  // either).
  const annotationList = () => props.annotations ?? [];
  const annotSource = useAnnotationSource(mapView, {
    annotations: annotationList,
    draft: () => null,
    selectedId: () => null,
    peers: () => [],
    identityColor: () => "#000000",
    visible: () => annotationList().length > 0,
    zoom: () => viewState().zoom,
    // Titles become callout labels below the exported circle (map-capture.ts).
    showLabels: () => false,
    // The 2048px capture scales the ~430px preview ~5×. Rasterizing the sprite
    // images at 8× (24 → 192px, the SVGs' intrinsic raster size) and declaring
    // that back as `pixelRatio` keeps pins/icons crisp at the capture scale
    // without changing their drawn size. Live maps use 4.
    iconScale: () => 8,
  });

  // Bumped per reconcile run so a run superseded by a fast layer switch stops
  // applying mid-loop.
  let replayGeneration = 0;

  // publishing the handle once, at
  // setup; the handle's members are accessors so the caller always sees current values
  // eslint-disable-next-line solid/reactivity
  props.ref?.({ getMap: () => getMap() });

  // Reconcile this instance's layers to match `entries`. Runs on mount AND
  // whenever the source layer set changes — a host `open-circular` message that
  // swaps layers must not remount this component (that tears down the MapLibre
  // map and refetches the basemap, sprites and tiles), so the diff happens here
  // instead. Sequential per layer: addLayer resolves after all batches are
  // loaded, so the hide that follows sees every child layer. MVT/COG adds
  // no-op until the map exists — handleLabelsReady re-syncs them below.
  //
  // Tracks the id LIST, not the `entries` array identity.
  createEffect(() => {
    const entryIds = props.entries.map((e) => e.config.id).join(",");
    void entryIds; // the tracked dependency

    const generation = ++replayGeneration;

    (async () => {
      // Read untracked at run time, so a change to only the hidden sets does
      // not restart the reconcile but the current values are still applied.
      const want = props.entries;
      const hidden = props.hiddenIds;
      const rules = props.hiddenRules;

      const desired = new Set(want.map((e) => e.config.id));
      // Drop layers no longer wanted. removeLayer also tears down the native
      // MVT/COG source, so re-adding the same id later is safe.
      for (const entry of [...layers.layerEntries()]) {
        if (desired.has(entry.config.id)) continue;
        layers.removeLayer(entry.config.id);
      }

      for (const entry of want) {
        if (generation !== replayGeneration) return;
        const id = entry.config.id;
        // `layerEntries()` is authoritative within this synchronous pass:
        // addLayer commits its entry before awaiting the data load, and rolls
        // it back if loading throws. (React needed a separate id set here,
        // because its state commit lagged the pass.)
        if (!layers.layerEntries().some((e) => e.config.id === id)) {
          // atEnd: `want` mirrors the live map's draw order, so append verbatim —
          // re-seeding by band would make the preview's z-order differ from the map.
          await layers.addLayer(entry.config, { atEnd: true });
          if (generation !== replayGeneration) return;
        }
        if (hidden.has(id)) {
          layers.hideLayer(id);
        }
        for (const ruleName of rules.get(id) ?? []) {
          layers.toggleRule(id, ruleName);
        }
      }

      // Native MVT/COG layers are skipped by addLayer until the style exists;
      // safe to call repeatedly.
      layers.syncImperativeLayers();
    })();
  });

  // MVT/COG layers are native MapLibre layers — re-add them once the style
  // (and after any basemap logic) is ready. syncImperativeLayers also replays
  // hidden layers and hidden classes, which fresh native layers don't carry.
  function handleLabelsReady() {
    if (!mapView()) return;
    layers.syncImperativeLayers();
    // These overlays live outside useMapLayers, so they need their own re-add.
    studyArea.resync();
    filteredStudyOverlay.resync();
    annotSource.resync();
  }

  function handleMove(evt: ViewStateChangeEvent) {
    setViewState((prev) => ({ ...prev, ...evt.viewState, pitch: 0, bearing: 0 }));
  }

  // Follow externally driven view changes. The preview seeds its own viewState
  // at mount (so user pan/zoom is local), but when the host reframes the map —
  // e.g. a gebiedsfilter fly-to arriving via `open-circular`/`map-command`
  // after mount — App feeds the new camera in through initialViewState. Adopt
  // it so the circle tracks the filter instead of staying on the mount frame.
  let lastInitial = props.initialViewState;
  createEffect(() => {
    const next = props.initialViewState;
    if (
      next.longitude === lastInitial.longitude &&
      next.latitude === lastInitial.latitude &&
      next.zoom === lastInitial.zoom
    ) {
      return;
    }
    lastInitial = next;
    setViewState((prev) => ({ ...prev, ...next }));
  });

  // The dialog portal mounts the container in one commit — make sure MapLibre
  // measures the final layout box.
  onMount(() => {
    const raf = requestAnimationFrame(() => getMap()?.resize());
    onCleanup(() => cancelAnimationFrame(raf));
  });

  return (
    <MapView
      ref={setMapView}
      basemapId={props.basemapId}
      style={{ width: "100%", height: "100%" }}
      viewState={viewState()}
      onMove={handleMove}
      onLabelsReady={handleLabelsReady}
      // PNG capture reads this map's canvas at idle — the buffer must survive
      // past the frame. Preview-only; the main maps skip the flag's perf cost.
      preserveDrawingBuffer
    />
  );
}
