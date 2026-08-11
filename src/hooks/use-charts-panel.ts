import { useCallback, useEffect, useRef, useState } from "react";
import { isChartEligible } from "@/layers/charts";
import type { LayerConfig } from "@/layers";
import type { UseMapLayersResult } from "@/hooks/use-map-layers";

export interface UseChartsPanelOptions {
  mapLeftLayers: UseMapLayersResult;
  mapRightLayers: UseMapLayersResult;
  /** map.json `chartsPanel`. When false, nothing auto-opens and no layer is eligible. */
  chartsPanelEnabled: boolean;
  /** Owned by usePanelMinimize — the panel shares the session-persisted flag. */
  setChartsMinimized: (next: boolean) => void;
  /** The area-select tool, disarmed when the selected layer disappears. */
  boxSelectActive: boolean;
  boxSelectToggle: () => void;
}

export interface UseChartsPanelResult {
  /**
   * The selected layer's config, resolved against both maps — or null when
   * nothing is selected or the selected layer is no longer on either map.
   * Every consumer gates on this rather than on the raw id.
   */
  chartLayerConfig: LayerConfig | null;
  /** Minimizes the panel (its close button). */
  handleChartsClose: () => void;
}

/**
 * Which layer the "Analyse & statistieken" panel is showing, and the rules that
 * open and close it.
 *
 * Owns the selected id rather than exposing it: the id is deliberately *kept*
 * when its layer is removed, so re-adding the same layer restores the selection,
 * and only the resolved `chartLayerConfig` reports "the layer is actually gone".
 * Handing out the raw id would invite consumers to gate on the wrong value.
 *
 * The panel's minimized flag is not owned here — it is one of the three
 * session-persisted window flags in `usePanelMinimize`, because the small-screen
 * auto-collapse writes all three together. This hook only pushes it.
 */
export function useChartsPanel({
  mapLeftLayers,
  mapRightLayers,
  chartsPanelEnabled,
  setChartsMinimized,
  boxSelectActive,
  boxSelectToggle,
}: UseChartsPanelOptions): UseChartsPanelResult {
  const [selectedChartLayerId, setSelectedChartLayerId] = useState<string | null>(null);

  const chartLayerConfig =
    (selectedChartLayerId &&
      (mapLeftLayers.layerEntries.find((e) => e.config.id === selectedChartLayerId)?.config ??
        mapRightLayers.layerEntries.find((e) => e.config.id === selectedChartLayerId)?.config)) ||
    null;

  const handleChartsClose = useCallback(() => setChartsMinimized(true), [setChartsMinimized]);
  // The selected layer being removed from both maps needs no effect to "close"
  // the panel: `chartLayerConfig` above already resolves to null in that case,
  // and every consumer gates on it. Clearing the id in an effect only forced a
  // second render pass to reach the state the first one had already derived.
  // The id is kept as-is so re-adding the same layer restores the selection.

  // Auto-open the panel when a layer with charts/statistics is added (via
  // navigation, URL command or embed host) — the newest eligible layer wins.
  const knownLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const known = knownLayerIdsRef.current;
    const next = new Set<string>();
    let added: string | null = null;
    for (const entry of [...mapLeftLayers.layerEntries, ...mapRightLayers.layerEntries]) {
      next.add(entry.config.id);
      if (!known.has(entry.config.id) && chartsPanelEnabled && isChartEligible(entry.config)) {
        added = entry.config.id;
      }
    }
    knownLayerIdsRef.current = next;
    if (added) {
      // Genuinely event-like ("an eligible layer just appeared"), not derived
      // state: it depends on diffing against the previously-seen id set, which
      // no render-time expression can reconstruct. An effect is the right tool
      // here, so the rule is suppressed rather than the code restructured.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedChartLayerId(added);
      setChartsMinimized(false);
    }
  }, [
    mapLeftLayers.layerEntries,
    mapRightLayers.layerEntries,
    chartsPanelEnabled,
    setChartsMinimized,
  ]);

  // The chart layer went away while the area-select tool was armed: turn it off
  // so the box doesn't linger invisibly in the filter behind a disabled button.
  // Gated on the resolved config, not the raw id: the id is deliberately kept
  // when the layer is removed (see above), so it is `chartLayerConfig` that
  // reports "the layer is actually gone".
  useEffect(() => {
    if (boxSelectActive && !chartLayerConfig) boxSelectToggle();
  }, [boxSelectActive, boxSelectToggle, chartLayerConfig]);

  return { chartLayerConfig, handleChartsClose };
}
