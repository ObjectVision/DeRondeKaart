import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { MapView } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers, type LayerEntry } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import {
  useFilteredStudyAreaLayers,
  type FilteredStudyArea,
} from "@/hooks/use-filtered-study-area";
import { useAnnotationLayers } from "@/hooks/use-annotation-layers";
import type { Annotation } from "@/types/annotation";

export interface ExportPreviewHandle {
  /** The preview's raw MapLibre map (null until loaded). */
  getMap(): MapLibreMap | null;
  /** The preview's deck.gl overlay — hi-res capture must sync its buffer size. */
  getOverlay(): MapboxOverlay | null;
}

/**
 * The circular export preview: a third MapView instance that mirrors the main
 * map's layers so the user can fine-tune the PNG framing without disturbing
 * the live map. deck.gl Layer instances cannot be shared across Deck overlays
 * (GL resources are per-instance — see App.tsx), so this component replays the
 * source entries into its own useMapLayers() and rebuilds every layer.
 */
export const ExportPreviewMap = forwardRef<
  ExportPreviewHandle,
  {
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
  }
>(function ExportPreviewMap(
  {
    entries,
    hiddenIds,
    hiddenRules,
    basemapId,
    studyAreaId,
    filteredStudy,
    annotations,
    initialViewState,
  },
  ref,
) {
  const layers = useMapLayers();
  // Same swap as the main maps: a gebiedsfilter selection replaces the
  // configured studyarea (skip loading it entirely — the dialog is a per-open
  // snapshot, so the choice never flips while mounted). Own layer instances:
  // deck Layers can't be shared across overlays.
  const studyLayers = useStudyAreaLayer(filteredStudy ? undefined : studyAreaId);
  const filteredStudyLayers = useFilteredStudyAreaLayers(filteredStudy ?? null, "export");
  const mapHandle = useRef<MapViewHandle>(null);
  const [viewState, setViewState] = useState<ViewState>(initialViewState);
  // Bumped per reconcile run so a superseded (StrictMode double-invoke, or a
  // fast layer switch) run stops applying mid-loop. See the effect below.
  const replayGeneration = useRef(0);
  // Layer ids this instance has added. Tracked here rather than read back from
  // `layers.layerEntries` because addLayer's state commit is async — within one
  // synchronous reconcile pass the hook's entries are still stale.
  const presentIdsRef = useRef<Set<string>>(new Set());

  useImperativeHandle(
    ref,
    () => ({
      getMap: () => mapHandle.current?.mapRef.current?.getMap() ?? null,
      getOverlay: () => mapHandle.current?.overlayRef.current ?? null,
    }),
    [],
  );

  // Reconcile this instance's layers to match `entries`. Runs on mount AND
  // whenever the source layer set changes — a host `open-circular` message that
  // swaps layers must not remount this component (that tears down the MapLibre
  // map and refetches the basemap, sprites and tiles), so the diff happens here
  // instead. Sequential per layer: addLayer resolves after all batches are
  // loaded, so the hide that follows sees every deck child layer. MVT/COG adds
  // no-op until the map exists — handleLabelsReady re-syncs them below.
  //
  // Keyed on the id list, not the `entries` array identity: App rebuilds that
  // array on unrelated renders.
  const entryIds = entries.map((e) => e.config.id).join(",");
  // Latest props for the async body — it must not re-run when only the hidden
  // sets change identity, but it must read their current values.
  const reconcileInputsRef = useRef({ entries, hiddenIds, hiddenRules });
  reconcileInputsRef.current = { entries, hiddenIds, hiddenRules };

  useEffect(() => {
    // Generation token instead of a cancellation flag: StrictMode runs
    // cleanup+effect again immediately after mount, and cancelling would abort
    // the loop after its first await — only the first layer would ever land.
    // A superseded run simply stops applying once a newer one starts; on a real
    // unmount the remaining setState calls hit a dead instance, which React
    // ignores.
    const generation = ++replayGeneration.current;

    (async () => {
      const previewMapRef = () => mapHandle.current?.mapRef ?? { current: null };
      const { entries: want, hiddenIds: hidden, hiddenRules: rules } =
        reconcileInputsRef.current;

      const desired = new Set(want.map((e) => e.config.id));
      // Drop layers no longer wanted. removeLayer also tears down the native
      // MVT/COG source, so re-adding the same id later is safe.
      for (const id of [...presentIdsRef.current]) {
        if (desired.has(id)) continue;
        layers.removeLayer(id, previewMapRef());
        presentIdsRef.current.delete(id);
      }

      for (const entry of want) {
        if (generation !== replayGeneration.current) return;
        const id = entry.config.id;
        if (!presentIdsRef.current.has(id)) {
          // Marked present BEFORE the await so a newer run overlapping this one
          // doesn't add the same layer twice. addLayer is itself idempotent on
          // id and rolls back its own entry if loading throws.
          presentIdsRef.current.add(id);
          await layers.addLayer(entry.config, previewMapRef());
          if (generation !== replayGeneration.current) return;
        }
        if (hidden.has(id)) {
          layers.hideLayer(id, previewMapRef());
        }
        for (const ruleName of rules.get(id) ?? []) {
          layers.toggleRule(id, ruleName, previewMapRef());
        }
      }

      // Native MVT/COG layers are skipped by addLayer until the style exists;
      // safe to call repeatedly.
      layers.syncImperativeLayers(previewMapRef());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryIds]);

  // MVT/COG layers are native MapLibre layers — re-add them once the style
  // (and after any basemap logic) is ready. syncImperativeLayers also replays
  // hidden layers and hidden classes, which fresh native layers don't carry.
  const handleLabelsReady = useCallback(() => {
    const mapRef = mapHandle.current?.mapRef;
    if (!mapRef) return;
    layers.syncImperativeLayers(mapRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.syncImperativeLayers]);

  const handleMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState((prev) => ({ ...prev, ...evt.viewState, pitch: 0, bearing: 0 }));
  }, []);

  // Follow externally driven view changes. The preview seeds its own viewState
  // at mount (so user pan/zoom is local), but when the host reframes the map —
  // e.g. a gebiedsfilter fly-to arriving via `open-circular`/`map-command`
  // after mount — App feeds the new camera in through initialViewState. Adopt
  // it so the circle tracks the filter instead of staying on the mount frame.
  const lastInitialRef = useRef(initialViewState);
  useEffect(() => {
    if (
      initialViewState.longitude === lastInitialRef.current.longitude &&
      initialViewState.latitude === lastInitialRef.current.latitude &&
      initialViewState.zoom === lastInitialRef.current.zoom
    ) {
      return;
    }
    lastInitialRef.current = initialViewState;
    setViewState((prev) => ({ ...prev, ...initialViewState }));
  }, [initialViewState]);

  // Annotations on the export: own layer instances (deck Layers can't be
  // shared across overlays), static view — no draft, selection, or peers.
  const annotationList = annotations ?? [];
  const annotLayers = useAnnotationLayers({
    annotations: annotationList,
    draft: null,
    selectedId: null,
    peers: [],
    identityColor: "#000000",
    visible: annotationList.length > 0,
    zoom: viewState.zoom,
    suffix: "export",
    // Titles become callout labels below the exported circle (map-capture.ts).
    showLabels: false,
    // The 2048px capture scales the ~430px preview ~5×. 8× atlas cells
    // (24 → 192px) match the SVGs' intrinsic 192px raster size — the decoded
    // bitmap lands 1:1 in the atlas, so pins/icons stay crisp in the export.
    // (deck decodes an SVG at the FILE's width/height; the icon-def size only
    // sets the atlas cell, so both must stay in step for a sharp texture.
    // The live maps use iconScale 4 — a clean 2× step down from 192.)
    iconScale: 8,
  });
  const studyOrFiltered = filteredStudy ? filteredStudyLayers : studyLayers;
  const topLayers = useMemo(
    () => [...studyOrFiltered, ...annotLayers],
    [studyOrFiltered, annotLayers],
  );

  // The dialog portal mounts the container in one commit — make sure MapLibre
  // measures the final layout box.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      mapHandle.current?.mapRef.current?.getMap()?.resize();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <MapView
      ref={mapHandle}
      layers={layers.deckLayers}
      topLayers={topLayers}
      basemapId={basemapId}
      style={{ width: "100%", height: "100%" }}
      viewState={viewState}
      onMove={handleMove}
      onLabelsReady={handleLabelsReady}
      // PNG capture reads this map's canvas at idle — the buffer must survive
      // past the frame (deck.gl's interleaved draws included). Preview-only;
      // the main maps skip the flag's perf cost.
      preserveDrawingBuffer
    />
  );
});
