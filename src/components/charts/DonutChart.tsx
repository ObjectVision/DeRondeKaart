import { For, type JSX } from "solid-js";
import { arc, pie, type PieArcDatum } from "d3-shape";
import type { ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatShare, formatValue } from "@/lib/format";

const SIZE = 120;
const R = SIZE / 2;

interface DonutChartProps {
  data: ChartDatum[];
  total: number;
  format: ChartValueFormat;
}

/** Donut with a formatted total in the center and an HTML legend at right. */
export function DonutChart(props: DonutChartProps): JSX.Element {
  const arcs = () =>
    pie<ChartDatum>()
      .value((d) => d.value)
      .sort(null)
      .padAngle(0.02)(props.data);

  const arcPath = arc<PieArcDatum<ChartDatum>>()
    .innerRadius(R * 0.62)
    .outerRadius(R - 1);

  return (
    <div class="flex items-center gap-3">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} class="w-28 flex-shrink-0">
        <g transform={`translate(${R}, ${R})`}>
          <For each={arcs()}>
            {(a) => (
              <path d={arcPath(a) ?? undefined} fill={a.data.color} stroke="#fff" stroke-width={2}>
                <title>{`${a.data.label}: ${formatValue(a.data.value, props.format)} (${formatShare(a.data.value, props.total)})`}</title>
              </path>
            )}
          </For>
          <text text-anchor="middle" dy="-0.1em" class="fill-gray-900 text-[15px] font-bold">
            {formatValue(props.total, props.format)}
          </text>
          <text text-anchor="middle" dy="1.2em" class="fill-gray-400 text-[9px]">
            totaal
          </text>
        </g>
      </svg>
      <ul class="flex min-w-0 flex-1 flex-col gap-px">
        <For each={props.data}>
          {(d) => (
            <li class="flex items-center gap-1 text-[10px] leading-tight">
              <span
                class="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ "background-color": d.color }}
              />
              <span class="min-w-0 flex-1 truncate text-gray-600" title={d.label}>
                {d.label}
              </span>
              <span class="flex-shrink-0 font-semibold text-gray-800">
                {formatShare(d.value, props.total)}
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
