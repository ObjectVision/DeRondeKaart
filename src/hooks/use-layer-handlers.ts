import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { MapAccessor, MapViewHandle } from "@/components/map/map-view-config";
import type { UseMapLayersResult } from "./use-map-layers";

/**
 * The legend/UI callbacks for ONE map's layer stack, plus that map's timeseries
 * playback timers.
 *
 * App drives two maps (A/B) whose handlers were previously written out twice,
 * identical apart from which `useMapLayers` result and which map handle they
 * closed over — so a fix to one side could silently miss the other. Binding the
 * pair once and calling this hook twice makes that class of drift impossible.
 */
export interface UseLayerHandlersResult {
  toggle: (layerId: string) => void;
  /** Dim the layer to 30%, or restore its configured opacity. */
  toggleDim: (layerId: string) => void;
  toggleRule: (layerId: string, ruleName: string) => void;
  togglePlay: (layerId: string) => void;
  setStep: (layerId: string, value: number) => void;
  remove: (layerId: string) => void;
  reorder: (layerId: string, toIndex: number) => void;
}

export function useLayerHandlers(
  layers: UseMapLayersResult,
  mapView: Accessor<MapViewHandle | null>,
): UseLayerHandlersResult {
  // The map may not be mounted yet (map B is conditional), so this resolves
  // lazily and yields null, which the layer helpers treat as "no map".
  const getMap: MapAccessor = () => mapView()?.map() ?? null;

  function toggle(layerId: string) {
    layers.toggleLayer(layerId, getMap);
  }

  function toggleDim(layerId: string) {
    layers.toggleDim(layerId, getMap);
  }

  function toggleRule(layerId: string, ruleName: string) {
    layers.toggleRule(layerId, ruleName, getMap);
  }

  function togglePlay(layerId: string) {
    layers.togglePlay(layerId);
  }

  // Scrubbing pauses playback, so the slider and the timer can't fight over
  // which step is rendered.
  function setStep(layerId: string, value: number) {
    layers.stopPlay(layerId);
    layers.setLayerStep(layerId, value, [getMap]);
  }

  function remove(layerId: string) {
    layers.removeLayer(layerId, getMap);
  }

  // Drag-reorder in the legend. `toIndex` is already in draw-order space (the
  // Legend converts from its reversed display order), and overrides the layer's
  // `beforeid` band.
  function reorder(layerId: string, toIndex: number) {
    layers.reorderLayer(layerId, toIndex, getMap);
  }

  // Timeseries playback: one interval per playing layer, re-armed whenever the
  // playing set changes. A tick reads the current step from the layer signals
  // inside advanceStep, so the interval never needs rebuilding for that.
  createEffect(() => {
    const playing = layers.playingIds();
    if (playing.size === 0) return;
    const entries = layers.layerEntries();
    const timers = [...playing].map((layerId) => {
      const entry = entries.find((e) => e.config.id === layerId);
      const intervalMs = entry?.config.timeseries?.intervalMs ?? 1000;
      return window.setInterval(() => {
        layers.advanceStep(layerId, [getMap]);
      }, intervalMs);
    });
    onCleanup(() => timers.forEach((t) => window.clearInterval(t)));
  });

  return { toggle, toggleDim, toggleRule, togglePlay, setStep, remove, reorder };
}
