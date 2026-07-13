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

const EMPTY: { charts: ResolvedChart[]; stats: ResolvedStat[] } = {
  charts: [],
  stats: [],
};

/**
 * Chart data + statistics for the analytics panel of one layer, restricted to
 * rows passing the area filter. `version` is the area-filter version; a bump
 * recomputes the aggregations.
 */
export function useChartData(config: LayerConfig | null, version: number) {
  const [result, setResult] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const configId = config?.id;
  useEffect(() => {
    if (!config) {
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
          setResult(EMPTY);
          return;
        }

        const charts = (config.charts ?? [])
          .map((id) => {
            const chart = library.get(id);
            if (!chart) console.warn(`layers.json: layer "${config.id}" references unknown chart "${id}"`);
            return chart;
          })
          .filter((c): c is NonNullable<typeof c> => c !== undefined)
          .slice(0, 4)
          .map((chart) => computeChartData(table, chart, config.source, version));

        const stats = computeStatistics(table, config.statistics ?? [], config.source, version);
        setResult({ charts, stats });
      } catch (err) {
        console.warn(`charts: failed to compute data for "${config.id}"`, err);
        if (!cancelled) setResult(EMPTY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, version]);

  return { charts: result.charts, stats: result.stats, loading };
}
