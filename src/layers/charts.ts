/**
 * Chart definitions for the analytics panel, loaded from `public/charts.json`.
 * charts.json is a library of chart definitions; layers reference them by id
 * via `LayerConfig.charts`.
 */
import type { ChartValueFormat, LayerConfig } from "./types";
import { loadConfig } from "@/config/load-config";

/** Formats whose own `source` is an attribute table the panel can read. */
const CHART_FORMATS = ["geoarrow", "parquet"];

/**
 * Can this layer open the analytics panel?
 *
 * Either its `source` is itself a readable table, or it names an
 * `attributeSource` sidecar — the pmtiles case, where the tiles render the map
 * but cannot supply whole-dataset aggregates.
 */
export function isChartEligible(config: LayerConfig): boolean {
  return (
    (CHART_FORMATS.includes(config.format) || Boolean(config.attributeSource)) &&
    Boolean(config.charts?.length || config.statistics?.length)
  );
}

export type ChartType = "donut" | "bar" | "line";
export type ChartAggregation = "sum" | "mean" | "count";

/** One named column rendered as a slice / bar / point. */
export interface ChartFieldSpec {
  field: string;
  label: string;
  color?: string;
}

/**
 * Chart data spec — exactly one variant:
 * - `fields`: each named column becomes one datum, accumulated per filtered
 *   row with the chart's aggregation. Array order = display order.
 * - `groupBy`: rows are grouped by a categorical column; per group either the
 *   row count (no `value`) or the aggregated `value` column. `labels` maps raw
 *   group values to display labels/colors.
 */
export interface ChartDataSpec {
  fields?: ChartFieldSpec[];
  groupBy?: string;
  value?: string;
  labels?: Record<string, { label?: string; color?: string }>;
}

export interface ChartConfig {
  id: string;
  title: string;
  type: ChartType;
  data: ChartDataSpec;
  aggregation: ChartAggregation;
  format: ChartValueFormat;
}

/**
 * Default categorical palette for chart series (overridable per field in
 * charts.json). The brand blue #00498D is reserved for chrome/headers.
 */
export const CHART_COLORS = [
  "#1c5cab",
  "#F97316",
  "#1baf7a",
  "#eda100",
  "#4a3aa7",
  "#e34948",
];

const CHART_TYPES: ChartType[] = ["donut", "bar", "line"];
const AGGREGATIONS: ChartAggregation[] = ["sum", "mean", "count"];
const FORMATS: ChartValueFormat[] = ["number", "percent", "currency"];


function validateChart(raw: unknown): ChartConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") return null;
  if (typeof obj.title !== "string" || obj.title === "") return null;
  if (!CHART_TYPES.includes(obj.type as ChartType)) return null;

  const data = obj.data as ChartDataSpec | undefined;
  if (typeof data !== "object" || data === null) return null;
  const hasFields =
    Array.isArray(data.fields) &&
    data.fields.length > 0 &&
    data.fields.every(
      (f) => typeof f === "object" && f !== null &&
        typeof f.field === "string" && typeof f.label === "string",
    );
  const hasGroupBy = typeof data.groupBy === "string" && data.groupBy !== "";
  if (!hasFields && !hasGroupBy) return null;

  const aggregation = AGGREGATIONS.includes(obj.aggregation as ChartAggregation)
    ? (obj.aggregation as ChartAggregation)
    : "sum";
  const format = FORMATS.includes(obj.format as ChartValueFormat)
    ? (obj.format as ChartValueFormat)
    : "number";

  return {
    id: obj.id,
    title: obj.title,
    type: obj.type as ChartType,
    data,
    aggregation,
    format,
  };
}

/**
 * Load `public/charts.json` (`{ "charts": [...] }`). Never throws: a missing
 * or invalid file yields an empty library; invalid entries are dropped with a
 * warning; duplicate ids first-wins.
 */
export async function loadChartsConfig(): Promise<Map<string, ChartConfig>> {
  return loadConfig({
    name: "charts.json",
    onError: () => new Map<string, ChartConfig>(),
    parse: (data) => {
      const list = (data as { charts?: unknown }).charts;
      const charts = new Map<string, ChartConfig>();
      if (!Array.isArray(list)) {
        console.warn('charts.json: expected { "charts": [...] }; no charts available');
        return charts;
      }
      for (const raw of list) {
        const chart = validateChart(raw);
        if (!chart) {
          console.warn(`charts.json: dropping invalid chart ${JSON.stringify(raw)}`);
          continue;
        }
        if (charts.has(chart.id)) {
          console.warn(`charts.json: duplicate chart id "${chart.id}"; keeping the first`);
          continue;
        }
        charts.set(chart.id, chart);
      }
      return charts;
    },
  });
}
