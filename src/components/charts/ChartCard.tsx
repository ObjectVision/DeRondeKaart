import type { ResolvedChart } from "@/layers/chart-data";
import { DonutChart } from "./DonutChart";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";

/** One chart tile in the analytics panel. */
export function ChartCard({ chart }: { chart: ResolvedChart }) {
  const { config, data, total } = chart;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2.5">
      <h4 className="mb-2 text-xs font-semibold text-gray-700">{config.title}</h4>
      {data.length === 0 || total === 0 ? (
        <div className="flex h-24 items-center justify-center text-xs text-gray-400">
          Geen data binnen filter
        </div>
      ) : config.type === "donut" ? (
        <DonutChart data={data} total={total} format={config.format} />
      ) : config.type === "bar" ? (
        <BarChart data={data} total={total} format={config.format} />
      ) : (
        <LineChart data={data} format={config.format} />
      )}
    </div>
  );
}
