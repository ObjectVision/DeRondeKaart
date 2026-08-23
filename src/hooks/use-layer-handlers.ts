import { createEffect, onCleanup } from "solid-js";
import type { UseMapLayersResult } from "./use-map-layers";

/**
 * Timeseries playback for ONE map's layer stack: the interval that advances a
 * playing layer, and the scrub that has to stop it. Every other legend callback
 * is a direct call on the stack itself.
 */
export interface UseLayerHandlersResult {
  /** Scrub to a step, pausing playback first. */
  setStep: (layerId: string, value: number) => void;
}

export function useLayerHandlers(layers: UseMapLayersResult): UseLayerHandlersResult {
  // Scrubbing pauses playback, so the slider and the timer can't fight over
  // which step is rendered.
  function setStep(layerId: string, value: number) {
    layers.stopPlay(layerId);
    layers.setLayerStep(layerId, value);
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
        layers.advanceStep(layerId);
      }, intervalMs);
    });
    onCleanup(() => timers.forEach((t) => window.clearInterval(t)));
  });

  return { setStep };
}
