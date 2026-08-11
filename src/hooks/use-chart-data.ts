import { useEffect, useState } from "react";
import { loadChartsConfig } from "@/layers/charts";
import {
  computeChartData,
  computeStatistics,
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
 * rows passing the area filter. `version` is the area-filter version; a bump
 * recomputes the aggregations.
 */
export interface UseChartDataResult extends ChartDataState {
  /** True while a table load is in flight. */
  loading: boolean;
}

export function useChartData(
  config: LayerConfig | null,
  version: number,
): UseChartDataResult {
  const [result, setResult] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const configId = config?.id;
  useEffect(() => {
    if (!config) {
      // Synchronous reset on the "no layer selected" path. Flagged by
      // react-hooks/set-state-in-effect, but this hook's whole job is to turn an
      // async table load into state; there is nothing to derive during render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
          loadTableForConfig(config),
        ]);
        if (cancelled) return;
        if (!table) {
          setResult(UNAVAILABLE);
          return;
        }
        // Memo key must identify the TABLE, not the layer: two layers sharing
        // one sidecar have different `source` values but identical data, and
        // keying on `source` would compute it twice under different keys.
        const tableKey = config.attributeSource ?? config.source;

        const charts = (config.charts ?? [])
          .map((id) => {
            const chart = library.get(id);
            if (!chart) console.warn(`layers.json: layer "${config.id}" references unknown chart "${id}"`);
            return chart;
          })
          .filter((c): c is NonNullable<typeof c> => c !== undefined)
          .slice(0, 4)
          .map((chart) => computeChartData(table, chart, tableKey, version));

        const stats = computeStatistics(table, config.statistics ?? [], tableKey, version);
        setResult({ charts, stats, unavailable: false });
      } catch (err) {
        console.warn(`charts: failed to compute data for "${config.id}"`, err);
        if (!cancelled) setResult(UNAVAILABLE);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, version]);

  return {
    charts: result.charts,
    stats: result.stats,
    unavailable: result.unavailable,
    loading,
  };
}
