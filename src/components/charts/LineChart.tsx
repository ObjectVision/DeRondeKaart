import { For, Show, createMemo, type JSX } from "solid-js";
import { area, line, curveMonotoneX } from "d3-shape";
import { scaleLinear, scalePoint } from "d3-scale";
import { chartSeries, type ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatValue } from "@/lib/format";

const WIDTH = 240;
const HEIGHT = 110;
const MARGIN = { top: 12, right: 34, bottom: 18, left: 40 };
const LINE_COLOR = "#1c5cab";

interface LineChartProps {
  data: ChartDatum[];
  format: ChartValueFormat;
}

/**
 * Line + area chart over an ordered dimension (datum labels = x ticks).
 *
 * With `series` on the data — the dashboard comparing several areas — one line
 * is drawn per series in that series' colour, and the filled area is dropped:
 * four translucent fills stacked on each other read as mud.
 */
export function LineChart(props: LineChartProps): JSX.Element {
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const series = createMemo(() => chartSeries(props.data));
  const multi = () => series().length > 0;

  /** One line's points, in the order the data arrived. */
  const lines = createMemo(() => {
    if (!multi()) return [{ label: "", color: LINE_COLOR, points: props.data }];
    return series().map((entry) => ({
      label: entry.label,
      color: entry.color,
      points: props.data.filter((d) => d.series?.label === entry.label),
    }));
  });

  const x = createMemo(() =>
    scalePoint<string>()
      .domain([...new Set(props.data.map((d) => d.label))])
      .range([0, plotW]),
  );
  const y = createMemo(() =>
    scaleLinear()
      .domain([0, Math.max(...props.data.map((d) => d.value), 1)])
      .nice()
      .range([plotH, 0]),
  );

  // The `.x`/`.y` arrows below run when the generator is invoked in the JSX —
  // a tracked scope — so reading the scale signals there is correct.
  /* eslint-disable solid/reactivity -- see above */
  const linePath = createMemo(() =>
    line<ChartDatum>()
      .x((d) => x()(d.label) ?? 0)
      .y((d) => y()(d.value))
      .curve(curveMonotoneX),
  );
  const areaPath = createMemo(() =>
    area<ChartDatum>()
      .x((d) => x()(d.label) ?? 0)
      .y0(plotH)
      .y1((d) => y()(d.value))
      .curve(curveMonotoneX),
  );
  /* eslint-enable solid/reactivity */

  const lastPoint = () => (multi() ? undefined : props.data[props.data.length - 1]);
  const ticks = createMemo(() => [...new Set(props.data.map((d) => d.label))]);

  return (
    <>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} class="w-full">
        <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
          <For each={y().ticks(3)}>
            {(t) => (
              <g>
                <line x1={0} x2={plotW} y1={y()(t)} y2={y()(t)} stroke="#e5e7eb" stroke-width={1} />
                <text
                  x={-6}
                  y={y()(t)}
                  text-anchor="end"
                  dominant-baseline="central"
                  class="fill-gray-400 text-[8px]"
                >
                  {formatValue(t, props.format)}
                </text>
              </g>
            )}
          </For>
          <Show when={!multi()}>
            <path d={areaPath()(props.data) ?? undefined} fill={LINE_COLOR} opacity={0.12} />
          </Show>
          <For each={lines()}>
            {(entry) => (
              <>
                <path
                  d={linePath()(entry.points) ?? undefined}
                  fill="none"
                  stroke={entry.color}
                  stroke-width={2}
                />
                <For each={entry.points}>
                  {(d) => (
                    <circle
                      cx={x()(d.label) ?? 0}
                      cy={y()(d.value)}
                      r={4}
                      fill={entry.color}
                      stroke="#fff"
                      stroke-width={2}
                    >
                      <title>
                        {entry.label
                          ? `${entry.label} — ${d.label}: ${formatValue(d.value, props.format)}`
                          : `${d.label}: ${formatValue(d.value, props.format)}`}
                      </title>
                    </circle>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={lastPoint()}>
            {(d) => (
              <text
                x={(x()(d().label) ?? 0) + 6}
                y={y()(d().value)}
                dominant-baseline="central"
                class="fill-gray-800 text-[9px] font-semibold"
              >
                {formatValue(d().value, props.format)}
              </text>
            )}
          </Show>
          <For each={ticks()}>
            {(label) => (
              <text
                x={x()(label) ?? 0}
                y={plotH + 12}
                text-anchor="middle"
                class="fill-gray-500 text-[8px]"
              >
                {label}
              </text>
            )}
          </For>
        </g>
      </svg>
      <Show when={multi()}>
        <ul class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          <For each={series()}>
            {(entry) => (
              <li class="flex items-center gap-1 text-[9px] text-gray-600">
                <span
                  class="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ "background-color": entry.color }}
                />
                {entry.label}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}
