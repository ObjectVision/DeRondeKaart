import { createEffect, createSignal, type Accessor } from "solid-js";
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
  boxSelectActive: Accessor<boolean>;
  boxSelectToggle: () => void;
}

export interface UseChartsPanelResult {
  /**
   * The selected layer's config, resolved against both maps — or null when
   * nothing is selected or the selected layer is no longer on either map.
   * Every consumer gates on this rather than on the raw id.
   */
  chartLayerConfig: Accessor<LayerConfig | null>;
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
export function useChartsPanel(options: UseChartsPanelOptions): UseChartsPanelResult {
  const [selectedChartLayerId, setSelectedChartLayerId] = createSignal<string | null>(null);

  // The selected layer being removed from both maps needs no effect to "close"
  // the panel: this resolves to null in that case, and every consumer gates on
  // it. The id is kept as-is so re-adding the same layer restores the selection.
  const chartLayerConfig = () => {
    const id = selectedChartLayerId();
    if (!id) return null;
    return (
      options.mapLeftLayers.layerEntries().find((e) => e.config.id === id)?.config ??
      options.mapRightLayers.layerEntries().find((e) => e.config.id === id)?.config ??
      null
    );
  };

  function handleChartsClose() {
    options.setChartsMinimized(true);
  }

  // Auto-open the panel when a layer with charts/statistics is added (via
  // navigation, URL command or embed host) — the newest eligible layer wins.
  // Genuinely event-like ("an eligible layer just appeared"): it depends on
  // diffing against the previously-seen id set, which no derived expression can
  // reconstruct, so an effect is the right tool.
  let knownLayerIds = new Set<string>();
  createEffect(() => {
    const next = new Set<string>();
    let added: string | null = null;
    for (const entry of [
      ...options.mapLeftLayers.layerEntries(),
      ...options.mapRightLayers.layerEntries(),
    ]) {
      next.add(entry.config.id);
      if (
        !knownLayerIds.has(entry.config.id) &&
        options.chartsPanelEnabled &&
        isChartEligible(entry.config)
      ) {
        added = entry.config.id;
      }
    }
    knownLayerIds = next;
    if (added) {
      setSelectedChartLayerId(added);
      options.setChartsMinimized(false);
    }
  });

  // The chart layer went away while the area-select tool was armed: turn it off
  // so the box doesn't linger invisibly in the filter behind a disabled button.
  // Gated on the resolved config, not the raw id: the id is deliberately kept
  // when the layer is removed (see above), so it is `chartLayerConfig` that
  // reports "the layer is actually gone".
  createEffect(() => {
    if (options.boxSelectActive() && !chartLayerConfig()) options.boxSelectToggle();
  });

  return { chartLayerConfig, handleChartsClose };
}
