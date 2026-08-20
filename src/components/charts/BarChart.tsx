import { For, createMemo, type JSX } from "solid-js";
import { scaleBand, scaleLinear } from "d3-scale";
import { chartSeries, type ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatShare, formatValue } from "@/lib/format";

const WIDTH = 240;
const ROW = 22;
const LABEL_W = 88;
const VALUE_W = 34;

interface BarChartProps {
  data: ChartDatum[];
  total: number;
  format: ChartValueFormat;
}

/**
 * Horizontal bar chart with category labels left and % of total at bar end.
 *
 * With `series` on the data — the dashboard comparing several areas — the bars
 * are grouped: one band per category, subdivided into one bar per area. The
 * end label then shows the value rather than a share, because a share of the
 * combined total of four areas answers no question anyone asked.
 */
export function BarChart(props: BarChartProps): JSX.Element {
  const series = createMemo(() => chartSeries(props.data));
  const grouped = () => series().length > 0;

  /** Categories in first-appearance order; several series repeat each one. */
  const categories = createMemo(() => [...new Set(props.data.map((d) => d.label))]);
  const rowHeight = () => ROW * Math.max(1, series().length);
  const plotHeight = () => categories().length * rowHeight();
  const height = () => plotHeight() + 14;
  const plotW = WIDTH - LABEL_W - VALUE_W;

  const x = createMemo(() =>
    scaleLinear()
      .domain([0, Math.max(...props.data.map((d) => d.value), 1)])
      .nice()
      .range([0, plotW]),
  );
  const y = createMemo(() =>
    scaleBand<string>()
      .domain(categories())
      .range([0, plotHeight()])
      .padding(0.35),
  );
  /** Sub-scale placing each series' bar inside its category band. */
  const ySeries = createMemo(() =>
    scaleBand<string>()
      .domain(series().map((entry) => entry.label))
      .range([0, y().bandwidth()])
      .padding(0.15),
  );
  const ticks = () => x().ticks(4);

  const barY = (d: ChartDatum) => {
    const band = y()(d.label) ?? 0;
    if (!d.series) return band;
    return band + (ySeries()(d.series.label) ?? 0);
  };
  const barHeight = (d: ChartDatum) => (d.series ? ySeries().bandwidth() : y().bandwidth());

  const endLabel = (d: ChartDatum) =>
    grouped() ? formatValue(d.value, props.format) : formatShare(d.value, props.total);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height()}`} class="w-full">
      <g transform={`translate(${LABEL_W}, 0)`}>
        <For each={ticks()}>
          {(t) => (
            <line
              x1={x()(t)}
              x2={x()(t)}
              y1={0}
              y2={plotHeight()}
              stroke="#e5e7eb"
              stroke-width={1}
            />
          )}
        </For>
        <For each={ticks()}>
          {(t) => (
            <text
              x={x()(t)}
              y={plotHeight() + 10}
              text-anchor="middle"
              class="fill-gray-400 text-[8px]"
            >
              {formatValue(t, props.format)}
            </text>
          )}
        </For>
        <For each={props.data}>
          {(d) => (
            <g transform={`translate(0, ${barY(d)})`}>
              <rect
                width={Math.max(x()(d.value), 0)}
                height={barHeight(d)}
                rx={2}
                fill={d.series?.color ?? d.color}
              >
                <title>
                  {d.series
                    ? `${d.series.label} — ${d.label}: ${formatValue(d.value, props.format)}`
                    : `${d.label}: ${formatValue(d.value, props.format)} (${formatShare(d.value, props.total)})`}
                </title>
              </rect>
              <text
                x={x()(d.value) + 4}
                y={barHeight(d) / 2}
                dominant-baseline="central"
                class="fill-gray-700 text-[9px] font-semibold"
              >
                {endLabel(d)}
              </text>
            </g>
          )}
        </For>
      </g>
      <For each={categories()}>
        {(label) => (
          <text
            x={LABEL_W - 6}
            y={(y()(label) ?? 0) + y().bandwidth() / 2}
            text-anchor="end"
            dominant-baseline="central"
            class="fill-gray-600 text-[9px]"
          >
            <title>{label}</title>
            {label.length > 18 ? `${label.slice(0, 17)}…` : label}
          </text>
        )}
      </For>
    </svg>
  );
}
