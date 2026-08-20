/**
 * Turns query results into the shapes the existing chart components already
 * take — `ResolvedChart` / `ResolvedStat` from `src/layers/chart-data.ts`.
 *
 * The dashboard deliberately reuses those types rather than inventing its own:
 * the components in `src/components/charts/` are pure and take resolved props,
 * so a DuckDB-backed dashboard renders through exactly the same code as the
 * map's analytics panel.
 *
 * Note this path is not subject to the four-chart cap in
 * `src/hooks/use-chart-data.ts` — that cap belongs to the map panel's layout,
 * not to the components.
 */
import { CHART_COLORS, type ChartConfig } from "@/layers/charts";
import type { ChartDatum, ResolvedChart, ResolvedStat } from "@/layers/chart-data";
import type { StatisticConfig } from "@/layers/types";
import type { QueryRow } from "@/dashboard/duckdb-engine";
import type { ModelMeasure } from "@/dashboard/semantic-model";
import type { QueryPlan } from "@/dashboard/query-builder";

/** DuckDB returns numbers, bigints or nulls; charts want plain numbers. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toLabel(value: unknown): string {
  if (value === null || value === undefined) return "Onbekend";
  return String(value);
}

/**
 * One measure over one grouped result: each group becomes a datum, coloured
 * from the shared categorical palette so a dashboard chart and a map-panel
 * chart of the same data look alike.
 */
export function chartFromResult(
  rows: QueryRow[],
  plan: QueryPlan,
  config: ChartConfig,
): ResolvedChart {
  const data: ChartDatum[] = [];
  const measure = plan.measures[0];
  const dimensionColumn = plan.dimensionColumn;

  if (dimensionColumn) {
    rows.forEach((row, index) => {
      data.push({
        label: toLabel(row[dimensionColumn]),
        value: toNumber(row[measure.id]),
        color: CHART_COLORS[index % CHART_COLORS.length],
      });
    });
  } else {
    // No dimension: one datum per measure instead of per group, so a chart can
    // still compare several measures side by side.
    const row = rows[0];
    plan.measures.forEach((entry, index) => {
      data.push({
        label: entry.label,
        value: row ? toNumber(row[entry.id]) : 0,
        color: CHART_COLORS[index % CHART_COLORS.length],
      });
    });
  }

  const total = data.reduce((sum, datum) => sum + datum.value, 0);
  return { config, data, total };
}

/** The single-row result of a measure-only query, as a statistic tile. */
export function statFromResult(
  rows: QueryRow[],
  measure: ModelMeasure,
  icon: string,
  label?: string,
): ResolvedStat {
  const row = rows[0];
  const config: StatisticConfig = {
    field: measure.expression,
    // The model's aggregation is already applied in SQL; this field only tells
    // the card what it is showing.
    stat: measure.aggregation === "min" || measure.aggregation === "max" ? "sum" : measure.aggregation,
    label: label ?? measure.label,
    icon,
    format: measure.format,
  };
  return { config, value: row ? toNumber(row[measure.id]) : 0 };
}
