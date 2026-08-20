import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { MapViewHandle } from "@/components/map/map-view-config";
import type { LayerConfig } from "@/layers";
import { canHighlight } from "@/layers";
import { featureKey, sameFeature, writeFeatureState, type FeatureKey } from "@/layers/feature-state";

/** Feature-state flags the highlight layer's paint expressions read. */
type HighlightKind = "highlight" | "selected";

export interface UseFeatureHighlightResult {
  /** Outline the feature under the pointer; pass null when there is none. */
  setHovered: (config: LayerConfig | null, featureId: string | number | null) => void;
  /** Outline the feature a click opened; pass null when the popup closes. */
  setSelected: (config: LayerConfig | null, featureId: string | number | null) => void;
  /** Drop both, e.g. after a basemap swap wipes the style. */
  clearAll: () => void;
}

/**
 * Drives MapLibre feature state for the hover and click highlights.
 *
 * MapLibre has no highlight API: `setFeatureState` flips a per-feature flag and
 * the highlight layer's paint expressions (see buildHighlightLayerDef) react to
 * it, repainting on the GPU without re-uploading tiles. That is what makes this
 * cheap enough to run from mousemove.
 *
 * Hover and selection are separate flags so a pinned feature stays outlined
 * while the pointer wanders off it.
 */
export function useFeatureHighlight(
  mapView: Accessor<MapViewHandle | null>,
): UseFeatureHighlightResult {
  // The currently-flagged feature per kind, so it can be cleared before the next
  // one is set. A plain object rather than a signal: nothing renders from it, it
  // is written from mousemove, and the previous key has to be readable
  // synchronously.
  const active: Record<HighlightKind, FeatureKey | null> = {
    highlight: null,
    selected: null,
  };

  function apply(
    kind: HighlightKind,
    config: LayerConfig | null,
    featureId: string | number | null,
  ) {
    const map = mapView()?.map();
    if (!map) return;

    const previous = active[kind];
    const next: FeatureKey | null =
      config && featureId !== null && canHighlight(config)
        ? featureKey(config, featureId)
        : null;

    if (sameFeature(previous, next)) return;

    // `false` is this channel's resting value; see writeFeatureState for why
    // clearing never uses removeFeatureState.
    if (previous) writeFeatureState(map, previous, kind, false);
    if (next) writeFeatureState(map, next, kind, true);

    active[kind] = next;
  }

  function setHovered(config: LayerConfig | null, featureId: string | number | null) {
    apply("highlight", config, featureId);
  }

  function setSelected(config: LayerConfig | null, featureId: string | number | null) {
    apply("selected", config, featureId);
  }

  function clearAll() {
    apply("highlight", null, null);
    apply("selected", null, null);
  }

  // A basemap swap calls setStyle, which drops every source together with its
  // feature state. Forget the held keys as soon as that happens rather than
  // waiting for App's resync: until they are dropped, the next hover would try
  // to clear a feature on a source that no longer exists.
  //
  // `styledata` also fires for ordinary style edits, which is harmless — the
  // keys are only a cache, and a stale hover is re-set on the next mousemove.
  //
  // Tracks `mapView()?.map()`, so a map that mounts later (the right pane) gets
  // the listener as soon as it exists rather than never.
  createEffect(() => {
    const map = mapView()?.map();
    if (!map) return;

    function forget() {
      active.highlight = null;
      active.selected = null;
    }

    map.on("styledata", forget);
    onCleanup(() => map.off("styledata", forget));
  });

  return { setHovered, setSelected, clearAll };
}
