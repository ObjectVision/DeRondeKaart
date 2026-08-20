import type { Map as MapLibreMap } from "maplibre-gl";

import type { LayerConfig } from "@/layers/types";
import { tileSourceId } from "@/hooks/use-map-layers";

/** What `setFeatureState` needs to address one feature. */
export interface FeatureKey {
  source: string;
  sourceLayer: string | undefined;
  id: string | number;
}

/**
 * Address one feature of a vector-tile layer.
 *
 * `sourceLayer` is read here rather than cached by the caller: a timeseries
 * layer rewrites it in place on every step, and a stale value addresses a
 * feature that is no longer there.
 */
export function featureKey(config: LayerConfig, featureId: string | number): FeatureKey {
  return {
    source: tileSourceId(config),
    sourceLayer: config.sourceLayer,
    id: featureId,
  };
}

/**
 * Whether two keys address the same feature.
 *
 * Lets a caller bail before touching the map: hover is driven from an
 * unthrottled mousemove, so without this every pixel of travel would re-set the
 * same feature state.
 */
export function sameFeature(a: FeatureKey | null, b: FeatureKey | null): boolean {
  return a?.id === b?.id && a?.source === b?.source && a?.sourceLayer === b?.sourceLayer;
}

/**
 * Write one channel of a feature's state, if its source is still on the map.
 *
 * **Clearing means writing a resting value — never `removeFeatureState`.**
 * MapLibre 6.3.0 throws from that call once the state has been flushed to a
 * tile: it records `deletedStates[layer][id] = null`, and `coalesceChanges`
 * then calls `Object.keys()` on that null, failing with "Cannot convert
 * undefined or null to object" on EVERY subsequent render — the map stops
 * painting. A basemap swap makes it certain, because the flush happens before
 * the pointer next moves.
 *
 * Writing the resting value is equivalent for the paint expressions these
 * channels feed: `["boolean", ["feature-state", k], false]` renders `false` and
 * absent identically, and `["coalesce", slot, NO_COMPARE_SLOT]` does the same
 * for the numeric channel. No state is ever deleted.
 *
 * The source check guards the window after a basemap swap, when a held key can
 * still name a source that has gone.
 */
export function writeFeatureState(
  map: MapLibreMap,
  key: FeatureKey,
  stateKey: string,
  value: boolean | number,
): void {
  if (!map.getSource(key.source)) return;
  map.setFeatureState(key, { [stateKey]: value });
}
