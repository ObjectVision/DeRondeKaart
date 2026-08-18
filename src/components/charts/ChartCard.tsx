import { Match, Switch, type JSX } from "solid-js";
import type { ResolvedChart } from "@/layers/chart-data";
import { DonutChart } from "./DonutChart";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";

interface ChartCardProps {
  chart: ResolvedChart;
}

/** One chart tile in the analytics panel. */
export function ChartCard(props: ChartCardProps): JSX.Element {
  const empty = () => props.chart.data.length === 0 || props.chart.total === 0;

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
