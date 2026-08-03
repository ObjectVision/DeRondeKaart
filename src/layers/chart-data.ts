/**
 * Aggregation for the analytics panel: turns a layer's arrow attribute table
 * into chart data and "Kerncijfers" statistics, counting ONLY rows that pass
 * the active gemeente/wijk/buurt area filter (the same predicate the map
 * rendering and picking use) AND the drawn box selection, if any.
 */
import type { Table } from "apache-arrow";
import { arrowRowMatchesAreaFilter } from "./area-filter";
import { arrowRowMatchesBoxFilter } from "./box-filter";
import { CHART_COLORS, type ChartConfig } from "./charts";
import type { LayerConfig, StatisticConfig } from "./types";
import { loadParquetBatches } from "./parquet-loader";
import { loadArrowBatches } from "./arrow-loader";

export interface ChartDatum {
  label: string;
  value: number;
  color: string;
}

export interface ResolvedChart {
  config: ChartConfig;
  data: ChartDatum[];
  /** Sum of datum values — drives the donut center and % labels. */
  total: number;
}

export interface ResolvedStat {
  config: StatisticConfig;
  value: number;
}

/**
 * Fetch the attribute table for a layer. The loaders are URL-cached, so for a
 * layer already on the map — or a sidecar shared by several layers — this
 * resolves without a second download.
 *
 * An `attributeSource` wins over `source`: it exists precisely because the
 * layer's own format (pmtiles/mvt/cog) serves tiles rather than a table.
 * Returns null when no table can be resolved.
 */
export function loadTableForConfig(config: LayerConfig): Promise<Table | null> {
  const sidecar = config.attributeSource;
  if (sidecar) {
    // Dispatch on the sidecar's own extension, not the layer's format — the
    // whole point is that the two differ.
    const url = sidecar.split("?")[0].toLowerCase();
    if (url.endsWith(".parquet")) return loadParquetBatches(sidecar, () => {});
    if (url.endsWith(".arrow") || url.endsWith(".feather")) {
      return loadArrowBatches(sidecar, () => {});
    }
    warnNoTable(
      config,
      `attributeSource "${sidecar}" is not a .parquet/.arrow/.feather file`,
    );
    return Promise.resolve(null);
  }

  switch (config.format) {
    case "parquet":
      return loadParquetBatches(config.source, () => {});
    case "geoarrow":
      return loadArrowBatches(config.source, () => {});
    default:
      // Declaring charts on a tile format without a sidecar renders an empty
      // panel and nothing else — say so, since that silence is exactly what hid
      // this after the layers moved from parquet to pmtiles.
      if (config.charts?.length || config.statistics?.length) {
        warnNoTable(
          config,
          `format "${config.format}" has no attribute table; add an ` +
            `"attributeSource" pointing at a .parquet/.arrow sidecar`,
        );
      }
      return Promise.resolve(null);
  }
}

const warnedNoTable = new Set<string>();

/** Warn once per layer that its analytics panel has no data to read. */
function warnNoTable(config: LayerConfig, reason: string) {
  if (warnedNoTable.has(config.id)) return;
  warnedNoTable.add(config.id);
  console.warn(`charts: layer "${config.id}" declares charts/statistics but ${reason}`);
}

/** Wrap a Table as the accessor-info shape arrowRowMatchesAreaFilter expects. */
function rowInfo(table: Table, index: number) {
  return { index, data: { data: table } };
}

/** A row counts iff it passes both the area filter AND the box selection. */
function rowPassesFilters(table: Table, index: number): boolean {
  return (
    arrowRowMatchesAreaFilter(rowInfo(table, index)) && arrowRowMatchesBoxFilter(table, index)
  );
}

const warnedMissingColumns = new Set<string>();

function warnMissingColumn(source: string, field: string) {
  const key = `${source}|${field}`;
  if (warnedMissingColumns.has(key)) return;
  warnedMissingColumns.add(key);
  console.warn(`charts: field "${field}" not found in ${source}`);
}

/** Bounded memo per (source, spec id, filter version). */
const memo = new Map<string, ResolvedChart | ResolvedStat[]>();
let memoVersion = -1;

function memoized<T extends ResolvedChart | ResolvedStat[]>(
  key: string,
  version: number,
  compute: () => T,
): T {
  if (version !== memoVersion) {
    memo.clear();
    memoVersion = version;
  }
  const hit = memo.get(key);
  if (hit) return hit as T;
  const result = compute();
  memo.set(key, result);
  return result;
}

/** Fold groups beyond this many into a single "Overig" datum. */
const MAX_GROUPS = 8;

/**
 * Compute a chart's data from the table, restricted to rows passing the area
 * filter and box selection. `version` is the combined filter version (cache
 * key only).
 */
export function computeChartData(
  table: Table,
  chart: ChartConfig,
  source: string,
  version: number,
): ResolvedChart {
  return memoized(`chart|${source}|${chart.id}`, version, () => {
    const data = chart.data.fields
      ? computeFieldsData(table, chart, source)
      : computeGroupByData(table, chart, source);
    const total = data.reduce((sum, d) => sum + d.value, 0);
    return { config: chart, data, total };
  });
}

function computeFieldsData(table: Table, chart: ChartConfig, source: string): ChartDatum[] {
  const specs = chart.data.fields!;
  const columns = specs.map((spec) => {
    const col = table.getChild(spec.field);
    if (!col) warnMissingColumn(source, spec.field);
    return col;
  });

  const sums = new Array<number>(specs.length).fill(0);
  const counts = new Array<number>(specs.length).fill(0);
  for (let i = 0; i < table.numRows; i++) {
    if (!rowPassesFilters(table, i)) continue;
    for (let f = 0; f < specs.length; f++) {
      const raw = columns[f]?.get(i);
      if (raw === null || raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      sums[f] += value;
      counts[f] += 1;
    }
  }

  return specs.map((spec, f) => {
    let value: number;
    switch (chart.aggregation) {
      case "count":
        value = counts[f];
        break;
      case "mean":
        value = counts[f] > 0 ? sums[f] / counts[f] : 0;
        break;
      default:
        value = sums[f];
    }
    return {
      label: spec.label,
      value,
      color: spec.color ?? CHART_COLORS[f % CHART_COLORS.length],
    };
  });
}

function computeGroupByData(table: Table, chart: ChartConfig, source: string): ChartDatum[] {
  const groupCol = table.getChild(chart.data.groupBy!);
  if (!groupCol) {
    warnMissingColumn(source, chart.data.groupBy!);
    return [];
  }
  const valueCol = chart.data.value ? table.getChild(chart.data.value) : null;
  if (chart.data.value && !valueCol) warnMissingColumn(source, chart.data.value);

  const groups = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < table.numRows; i++) {
    if (!rowPassesFilters(table, i)) continue;
    const raw = groupCol.get(i);
    if (raw === null || raw === undefined) continue;
    const key = String(raw);
    const acc = groups.get(key) ?? { sum: 0, count: 0 };
    acc.count += 1;
    if (valueCol) {
      const v = Number(valueCol.get(i));
      if (Number.isFinite(v)) acc.sum += v;
    }
    groups.set(key, acc);
  }

  const labels = chart.data.labels ?? {};
  const data = [...groups.entries()].map(([key, acc]) => {
    let value: number;
    switch (chart.aggregation) {
      case "sum":
        value = valueCol ? acc.sum : acc.count;
        break;
      case "mean":
        value = valueCol && acc.count > 0 ? acc.sum / acc.count : acc.count;
        break;
      default:
        value = acc.count;
    }
    return { key, label: labels[key]?.label ?? key, value, color: labels[key]?.color };
  });
  data.sort((a, b) => b.value - a.value);

  const head = data.slice(0, MAX_GROUPS);
  const rest = data.slice(MAX_GROUPS);
  const result: ChartDatum[] = head.map((d, i) => ({
    label: d.label,
    value: d.value,
    color: d.color ?? CHART_COLORS[i % CHART_COLORS.length],
  }));
  if (rest.length > 0) {
    result.push({
      label: "Overig",
      value: rest.reduce((sum, d) => sum + d.value, 0),
      color: "#9ca3af",
    });
  }
  return result;
}

/**
 * Compute the "Kerncijfers" statistics over the filtered rows. Variance is
 * the population variance (Welford's algorithm for numerical stability).
 */
export function computeStatistics(
  table: Table,
  stats: StatisticConfig[],
  source: string,
  version: number,
): ResolvedStat[] {
  if (stats.length === 0) return [];
  const specKey = stats.map((s) => `${s.field}:${s.stat}`).join(",");
  return memoized(`stats|${source}|${specKey}`, version, () => {
    const accs = stats.map((stat) => {
      const col = table.getChild(stat.field);
      if (!col) warnMissingColumn(source, stat.field);
      return { col, nonNull: 0, count: 0, sum: 0, mean: 0, m2: 0 };
    });

    for (let i = 0; i < table.numRows; i++) {
      if (!rowPassesFilters(table, i)) continue;
      for (const acc of accs) {
        const raw = acc.col?.get(i);
        if (raw === null || raw === undefined) continue;
        // "count" counts any non-null value (also non-numeric fields such as
        // code strings); sum/mean/variance accumulate numeric values only.
        acc.nonNull += 1;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        acc.count += 1;
        acc.sum += value;
        const delta = value - acc.mean;
        acc.mean += delta / acc.count;
        acc.m2 += delta * (value - acc.mean);
      }
    }

    return stats.map((stat, s) => {
      const acc = accs[s];
      let value: number;
      switch (stat.stat) {
        case "count":
          value = acc.nonNull;
          break;
        case "sum":
          value = acc.sum;
          break;
        case "mean":
          value = acc.count > 0 ? acc.mean : 0;
          break;
        case "variance":
          value = acc.count > 0 ? acc.m2 / acc.count : 0;
          break;
      }
      return { config: stat, value };
    });
  });
}
