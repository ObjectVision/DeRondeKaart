import { createEffect, onCleanup, type Accessor } from "solid-js";
import type { MapViewHandle } from "@/components/map/map-view-config";
import type { LayerConfig } from "@/layers";
import { canHighlight } from "@/layers";
import { tileSourceId } from "@/hooks/use-map-layers";

/** What `setFeatureState` needs to address one feature. */
interface FeatureKey {
  source: string;
  sourceLayer: string | undefined;
  id: string | number;
}

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
        ? {
            source: tileSourceId(config),
            // Read at call time rather than cached: a timeseries layer
            // rewrites `sourceLayer` in place on every step, and a stale value
            // addresses a feature that is no longer there.
            sourceLayer: config.sourceLayer,
            id: featureId,
          }
        : null;

    // Unchanged: bail before touching the map. Mousemove is unthrottled, so
    // without this every pixel of travel would re-set the same feature state.
    if (
      previous?.id === next?.id &&
      previous?.source === next?.source &&
      previous?.sourceLayer === next?.sourceLayer
    ) {
      return;
    }

    // Clearing is done by writing `false`, not by removeFeatureState.
    //
    // MapLibre 6.3.0 throws from removeFeatureState when the feature's state
    // was already flushed to a tile: it records `deletedStates[layer][id] =
    // null`, and coalesceChanges then calls Object.keys() on that null,
    // failing with "Cannot convert undefined or null to object" on EVERY
    // subsequent render — the map stops painting. A basemap swap makes it
    // certain, because the flush happens before the pointer next moves.
    //
    // Setting the flag false is equivalent here: the paint expressions test
    // `["boolean", ["feature-state", kind], false]`, so false and absent
    // render identically, and no state is ever deleted.
    if (previous && map.getSource(previous.source)) {
      map.setFeatureState(previous, { [kind]: false });
    }

    if (next && map.getSource(next.source)) {
      map.setFeatureState(next, { [kind]: true });
    }

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
