import { For, Match, Switch, createMemo, type JSX } from "solid-js";
import { chartSeries, type ResolvedChart } from "@/layers/chart-data";
import { DonutChart } from "./DonutChart";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";

interface ChartCardProps {
  chart: ResolvedChart;
}

/** One chart tile in the analytics panel. */
export function ChartCard(props: ChartCardProps): JSX.Element {
  const empty = () => props.chart.data.length === 0 || props.chart.total === 0;

  // A donut cannot hold several series in one ring — parts of a whole stop
  // meaning anything once two wholes are involved — so a comparison renders one
  // small donut per area instead.
  const donutMultiples = createMemo(() => {
    const series = chartSeries(props.chart.data);
    return series.map((entry) => {
      const data = props.chart.data.filter((datum) => datum.series?.label === entry.label);
      return {
        label: entry.label,
        data,
        total: data.reduce((sum, datum) => sum + datum.value, 0),
      };
    });
  });

  return (
    <div class="rounded-xl border border-gray-200 bg-white p-2.5">
      <h4 class="mb-2 text-xs font-semibold text-gray-700">{props.chart.config.title}</h4>
      <Switch
        fallback={
          <LineChart data={props.chart.data} format={props.chart.config.format} />
        }
      >
        <Match when={empty()}>
          <div class="flex h-24 items-center justify-center text-xs text-gray-400">
            Geen data binnen filter
          </div>
        </Match>
        <Match when={props.chart.config.type === "donut" && donutMultiples().length > 0}>
          <div class="flex flex-wrap gap-2">
            <For each={donutMultiples()}>
              {(multiple) => (
                <div class="min-w-0 flex-1">
                  <div class="mb-1 truncate text-[10px] font-semibold text-gray-600">
                    {multiple.label}
                  </div>
                  <DonutChart
                    data={multiple.data}
                    total={multiple.total}
                    format={props.chart.config.format}
                  />
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={props.chart.config.type === "donut"}>
          <DonutChart
            data={props.chart.data}
            total={props.chart.total}
            format={props.chart.config.format}
          />
        </Match>
        <Match when={props.chart.config.type === "bar"}>
          <BarChart
            data={props.chart.data}
            total={props.chart.total}
            format={props.chart.config.format}
          />
        </Match>
      </Switch>
    </div>
  );
}
