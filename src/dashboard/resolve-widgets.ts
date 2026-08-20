/**
 * Runs a layout's widgets against the engine and hands back render-ready tiles.
 *
 * One query per widget rather than one combined query: widgets group by
 * different dimensions and a single statement cannot serve two grains, and a
 * failing widget should cost only itself. DuckDB answers from the same
 * registered views either way.
 */
import type { ChartConfig } from "@/layers/charts";
import type { ResolvedChart, ResolvedStat } from "@/layers/chart-data";
import type { DuckDbEngine } from "@/dashboard/duckdb-engine";
import type { DashboardWidget } from "@/dashboard/layout-config";
import type { SemanticModel } from "@/dashboard/semantic-model";
import { buildQuery, type QueryFilter } from "@/dashboard/query-builder";
import { chartFromResult, statFromResult } from "@/dashboard/widget-data";

/** Icon for a statistic tile whose measure names none. */
const DEFAULT_STAT_ICON = "insights";

export type ResolvedWidget =
  | { kind: "chart"; span: number; chart: ResolvedChart }
  | { kind: "statistic"; span: number; stat: ResolvedStat }
  | { kind: "text"; span: number; title?: string; body: string }
  | { kind: "unavailable"; span: number; title?: string };

export interface ResolveContext {
  engine: DuckDbEngine;
  model: SemanticModel;
  charts: Map<string, ChartConfig>;
  filters: QueryFilter[];
}

/**
 * Which measures a chart widget plots: its own list, else the referenced
 * chart's `data.fields[].field` names read as measure ids.
 */
function measuresFor(widget: DashboardWidget, chart: ChartConfig): string[] {
  if (widget.measures) return widget.measures;
  return (chart.data.fields ?? []).map((field) => field.field);
}

async function resolveOne(
  widget: DashboardWidget,
  context: ResolveContext,
): Promise<ResolvedWidget> {
  const span = widget.span ?? 1;

  if (widget.kind === "text") {
    return { kind: "text", span, title: widget.title, body: widget.body ?? "" };
  }

  if (widget.kind === "statistic") {
    const measure = context.model.measures.get(widget.ref!);
    if (!measure) {
      console.warn(`dashboard: statistic widget names unknown measure "${widget.ref}"`);
      return { kind: "unavailable", span, title: widget.title };
    }
    const plan = buildQuery(context.model, {
      measures: [measure.id],
      filters: context.filters,
    });
    if (!plan) return { kind: "unavailable", span, title: widget.title };

    const rows = await context.engine.query(plan.sql);
    return {
      kind: "statistic",
      span,
      stat: statFromResult(rows, measure, DEFAULT_STAT_ICON, widget.title),
    };
  }

  const chart = context.charts.get(widget.ref!);
  if (!chart) {
    console.warn(`dashboard: chart widget names unknown chart id "${widget.ref}"`);
    return { kind: "unavailable", span, title: widget.title };
  }
  const plan = buildQuery(context.model, {
    measures: measuresFor(widget, chart),
    dimension: widget.dimension,
    filters: context.filters,
  });
  if (!plan) return { kind: "unavailable", span, title: widget.title };

  const rows = await context.engine.query(plan.sql);
  // The widget's own title wins over the library chart's, so one chart
  // definition can appear twice under different headings.
  const config = widget.title ? { ...chart, title: widget.title } : chart;
  return { kind: "chart", span, chart: chartFromResult(rows, plan, config) };
}

/**
 * Resolve every widget, keeping the layout's order. A widget whose query throws
 * becomes an "unavailable" tile: one unreadable parquet file must not take the
 * whole page down.
 */
export async function resolveWidgets(
  widgets: DashboardWidget[],
  context: ResolveContext,
): Promise<ResolvedWidget[]> {
  const out: ResolvedWidget[] = [];
  for (const widget of widgets) {
    try {
      out.push(await resolveOne(widget, context));
    } catch (err) {
      console.warn(`dashboard: widget "${widget.ref ?? widget.kind}" failed`, err);
      out.push({ kind: "unavailable", span: widget.span ?? 1, title: widget.title });
    }
  }
  return out;
}
