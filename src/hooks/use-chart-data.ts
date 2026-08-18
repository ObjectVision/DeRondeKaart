import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { loadChartsConfig } from "@/layers/charts";
import {
  computeChartData,
  computeStatistics,
  filterEpoch,
  loadTableForConfig,
  type ResolvedChart,
  type ResolvedStat,
} from "@/layers/chart-data";
import type { LayerConfig } from "@/layers/types";

interface ChartDataState {
  charts: ResolvedChart[];
  stats: ResolvedStat[];
  /**
   * True when no attribute table could be loaded at all — distinct from a table
   * that simply yielded no rows, so the panel can explain itself instead of
   * rendering blank.
   */
  unavailable: boolean;
}

const EMPTY: ChartDataState = { charts: [], stats: [], unavailable: false };
const UNAVAILABLE: ChartDataState = { charts: [], stats: [], unavailable: true };

/**
 * Chart data + statistics for the analytics panel of one layer, restricted to
 * rows passing the area and box filters.
 *
 * No `version` parameter: the effect reads `filterEpoch()`, which subscribes it
 * to both filter stores directly. React had to be handed that number because it
 * could not observe the stores itself.
 */
export interface UseChartDataResult {
  charts: Accessor<ResolvedChart[]>;
  stats: Accessor<ResolvedStat[]>;
  /**
   * True when no attribute table could be loaded at all — distinct from a table
   * that simply yielded no rows, so the panel can explain itself instead of
   * rendering blank.
   */
  unavailable: Accessor<boolean>;
  /** True while a table load is in flight. */
  loading: Accessor<boolean>;
}

export function useChartData(config: Accessor<LayerConfig | null>): UseChartDataResult {
  const [result, setResult] = createSignal(EMPTY);
  const [loading, setLoading] = createSignal(false);

  createEffect(() => {
    const current = config();
    // Tracked here so a filter change recomputes even though the layer did not.
    const version = filterEpoch();
    if (!current) {
      setResult(EMPTY);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [library, table] = await Promise.all([
          loadChartsConfig(),
          loadTableForConfig(current),
        ]);
        if (cancelled) return;
        if (!table) {
          setResult(UNAVAILABLE);
          return;
        }
        // Memo key must identify the TABLE, not the layer: two layers sharing
        // one sidecar have different `source` values but identical data, and
        // keying on `source` would compute it twice under different keys.
        const tableKey = current.attributeSource ?? current.source;

        const charts = (current.charts ?? [])
          .map((id) => {
            const chart = library.get(id);
            if (!chart) console.warn(`layers.json: layer "${current.id}" references unknown chart "${id}"`);
            return chart;
          })
          .filter((c): c is NonNullable<typeof c> => c !== undefined)
          .slice(0, 4)
          .map((chart) => computeChartData(table, chart, tableKey, version));

        const stats = computeStatistics(table, current.statistics ?? [], tableKey, version);
        setResult({ charts, stats, unavailable: false });
      } catch (err) {
        console.warn(`charts: failed to compute data for "${current.id}"`, err);
        if (!cancelled) setResult(UNAVAILABLE);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  return {
    charts: () => result().charts,
    stats: () => result().stats,
    unavailable: () => result().unavailable,
    loading,
  };
}
