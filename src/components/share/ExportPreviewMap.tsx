import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { MapView } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers, type LayerEntry } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";

export interface ExportPreviewHandle {
  /** The preview's raw MapLibre map (null until loaded). */
  getMap(): MapLibreMap | null;
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
    initialViewState: ViewState;
  }
>(function ExportPreviewMap(
  { entries, hiddenIds, hiddenRules, basemapId, studyAreaId, initialViewState },
  ref,
) {
  const layers = useMapLayers();
  const studyLayers = useStudyAreaLayer(studyAreaId);
  const mapHandle = useRef<MapViewHandle>(null);
  const [viewState, setViewState] = useState<ViewState>(initialViewState);
  // The dialog mounts a fresh instance per open, so replay-once refs reset
  // naturally; they only guard against StrictMode's double effect run.
  const didReplay = useRef(false);

  useImperativeHandle(
    ref,
    () => ({ getMap: () => mapHandle.current?.mapRef.current?.getMap() ?? null }),
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
      topLayers={studyLayers}
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
