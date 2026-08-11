import { useCallback, useEffect, useMemo } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { UseMapLayersResult } from "./use-map-layers";

/**
 * The legend/UI callbacks for ONE map's layer stack, plus that map's timeseries
 * playback timers.
 *
 * App drives two maps (A/B) whose handlers were previously written out twice,
 * identical apart from which `useMapLayers` result and which map ref they
 * closed over — so a fix to one side could silently miss the other. Binding the
 * pair once and calling this hook twice makes that class of drift impossible.
 */
export interface UseLayerHandlersResult {
  toggle: (layerId: string) => void;
  toggleRule: (layerId: string, ruleName: string) => void;
  togglePlay: (layerId: string) => void;
  setStep: (layerId: string, value: number) => void;
  remove: (layerId: string) => void;
  reorder: (layerId: string, toIndex: number) => void;
}

export function useLayerHandlers(
  layers: UseMapLayersResult,
  mapViewRef: React.RefObject<MapViewHandle | null>,
): UseLayerHandlersResult {
  // The map may not be mounted yet (map B is conditional), so every call
  // resolves the ref lazily and falls back to an empty one the layer helpers
  // treat as "no map".
  const resolveMapRef = useCallback(
    (): React.RefObject<MapRef | null> => mapViewRef.current?.mapRef ?? { current: null },
    [mapViewRef],
  );

  const toggle = useCallback(
    (layerId: string) => {
      layers.toggleLayer(layerId, resolveMapRef());
    },
    [layers, resolveMapRef],
  );

  const toggleRule = useCallback(
    (layerId: string, ruleName: string) => {
      layers.toggleRule(layerId, ruleName, resolveMapRef());
    },
    [layers, resolveMapRef],
  );

  const togglePlay = useCallback(
    (layerId: string) => {
      layers.togglePlay(layerId);
    },
    [layers],
  );

  // Scrubbing pauses playback, so the slider and the timer can't fight over
  // which step is rendered.
  const setStep = useCallback(
    (layerId: string, value: number) => {
      layers.stopPlay(layerId);
      layers.setLayerStep(layerId, value, [resolveMapRef()]);
    },
    [layers, resolveMapRef],
  );

  const remove = useCallback(
    (layerId: string) => {
      layers.removeLayer(layerId, resolveMapRef());
    },
    [layers, resolveMapRef],
  );

  // Drag-reorder in the legend. `toIndex` is already in draw-order space (the
  // Legend converts from its reversed display order), and overrides the layer's
  // `beforeid` band.
  const reorder = useCallback(
    (layerId: string, toIndex: number) => {
      layers.reorderLayer(layerId, toIndex, resolveMapRef());
    },
    [layers, resolveMapRef],
  );

  // Timeseries playback: one interval per playing layer. Re-armed whenever the
  // playing set changes; the step itself is read from the hook's ref inside
  // advanceStep, so a tick never needs the interval rebuilt.
  useEffect(() => {
    if (layers.playingIds.size === 0) return;
    const timers = [...layers.playingIds].map((layerId) => {
      const entry = layers.layerEntries.find((e) => e.config.id === layerId);
      const intervalMs = entry?.config.timeseries?.intervalMs ?? 1000;
      return window.setInterval(() => {
        layers.advanceStep(layerId, [resolveMapRef()]);
      }, intervalMs);
    });
    return () => timers.forEach((t) => window.clearInterval(t));
  }, [layers, resolveMapRef]);

  return useMemo(
    () => ({ toggle, toggleRule, togglePlay, setStep, remove, reorder }),
    [toggle, toggleRule, togglePlay, setStep, remove, reorder],
  );
}
