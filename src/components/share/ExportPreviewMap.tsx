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
  // The dialog mounts a fresh instance per open, so replay-once refs reset
  // naturally; they only guard against StrictMode's double effect run.
  const didReplay = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      getMap: () => mapHandle.current?.mapRef.current?.getMap() ?? null,
      getOverlay: () => mapHandle.current?.overlayRef.current ?? null,
    }),
    [],
  );

  // Replay the main map's entries into this instance. Sequential per layer:
  // addLayer resolves after all batches are loaded, so the hide that follows
  // sees every deck child layer. MVT/COG adds no-op until the map exists —
  // handleLabelsReady re-syncs them below.
  useEffect(() => {
    if (didReplay.current) return;
    didReplay.current = true;

    // One-shot, deliberately NOT cancelled on cleanup: StrictMode runs
    // cleanup+effect again immediately after mount, and a cancellation flag
    // would abort this loop after its first await — only the first layer
    // would ever replay. The ref guard already prevents a second loop; on a
    // real unmount the remaining setState calls land on a dead instance,
    // which React ignores.
    (async () => {
      const previewMapRef = () => mapHandle.current?.mapRef ?? { current: null };
      for (const entry of entries) {
        await layers.addLayer(entry.config, previewMapRef());
        if (hiddenIds.has(entry.config.id)) {
          layers.hideLayer(entry.config.id, previewMapRef());
        }
        for (const ruleName of hiddenRules.get(entry.config.id) ?? []) {
          layers.toggleRule(entry.config.id, ruleName, previewMapRef());
        }
      }
    })();
    // Snapshot semantics: the preview mirrors the state at dialog-open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MVT/COG layers are native MapLibre layers — re-add them once the style
  // (and after any basemap logic) is ready, then reapply hidden visibility
  // (a hide replayed before the map existed couldn't reach native layers).
  const handleLabelsReady = useCallback(() => {
    const mapRef = mapHandle.current?.mapRef;
    if (!mapRef) return;
    layers.syncImperativeLayers(mapRef);
    for (const id of hiddenIds) {
      layers.hideLayer(id, mapRef);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.syncImperativeLayers, hiddenIds]);

  const handleMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState((prev) => ({ ...prev, ...evt.viewState, pitch: 0, bearing: 0 }));
  }, []);

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
