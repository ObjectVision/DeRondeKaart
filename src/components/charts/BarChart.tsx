import { For, createMemo, type JSX } from "solid-js";
import { scaleBand, scaleLinear } from "d3-scale";
import type { ChartDatum } from "@/layers/chart-data";
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

/** Horizontal bar chart with category labels left and % of total at bar end. */
export function BarChart(props: BarChartProps): JSX.Element {
  const height = () => props.data.length * ROW + 14;
  const plotW = WIDTH - LABEL_W - VALUE_W;

  const x = createMemo(() =>
    scaleLinear()
      .domain([0, Math.max(...props.data.map((d) => d.value), 1)])
      .nice()
      .range([0, plotW]),
  );
  const y = createMemo(() =>
    scaleBand<string>()
      .domain(props.data.map((d) => d.label))
      .range([0, props.data.length * ROW])
      .padding(0.35),
  );
  const ticks = () => x().ticks(4);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height()}`} class="w-full">
      <g transform={`translate(${LABEL_W}, 0)`}>
        <For each={ticks()}>
          {(t) => (
            <line
              x1={x()(t)}
              x2={x()(t)}
              y1={0}
              y2={props.data.length * ROW}
              stroke="#e5e7eb"
              stroke-width={1}
            />
          )}
        </For>
        <For each={ticks()}>
          {(t) => (
            <text
              x={x()(t)}
              y={props.data.length * ROW + 10}
              text-anchor="middle"
              class="fill-gray-400 text-[8px]"
            >
              {formatValue(t, props.format)}
            </text>
          )}
        </For>
        <For each={props.data}>
          {(d) => (
            <g transform={`translate(0, ${y()(d.label) ?? 0})`}>
              <rect
                width={Math.max(x()(d.value), 0)}
                height={y().bandwidth()}
                rx={2}
                fill={d.color}
              >
                <title>{`${d.label}: ${formatValue(d.value, props.format)} (${formatShare(d.value, props.total)})`}</title>
              </rect>
              <text
                x={x()(d.value) + 4}
                y={y().bandwidth() / 2}
                dominant-baseline="central"
                class="fill-gray-700 text-[9px] font-semibold"
              >
                {formatShare(d.value, props.total)}
              </text>
            </g>
          )}
        </For>
      </g>
      <For each={props.data}>
        {(d) => (
          <text
            x={LABEL_W - 6}
            y={(y()(d.label) ?? 0) + y().bandwidth() / 2}
            text-anchor="end"
            dominant-baseline="central"
            class="fill-gray-600 text-[9px]"
          >
            <title>{d.label}</title>
            {d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label}
          </text>
        )}
      </For>
    </svg>
  );
}
