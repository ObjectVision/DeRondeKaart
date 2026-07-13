import { scaleBand, scaleLinear } from "d3-scale";
import type { ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatShare, formatValue } from "@/lib/format";

const WIDTH = 240;
const ROW = 22;
const LABEL_W = 88;
const VALUE_W = 34;

/** Horizontal bar chart with category labels left and % of total at bar end. */
export function BarChart({
  data,
  total,
  format,
}: {
  data: ChartDatum[];
  total: number;
  format: ChartValueFormat;
}) {
  const height = data.length * ROW + 14;
  const plotW = WIDTH - LABEL_W - VALUE_W;
  const x = scaleLinear()
    .domain([0, Math.max(...data.map((d) => d.value), 1)])
    .nice()
    .range([0, plotW]);
  const y = scaleBand<string>()
    .domain(data.map((d) => d.label))
    .range([0, data.length * ROW])
    .padding(0.35);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full">
      <g transform={`translate(${LABEL_W}, 0)`}>
        {x.ticks(4).map((t) => (
          <line
            key={t}
            x1={x(t)}
            x2={x(t)}
            y1={0}
            y2={data.length * ROW}
            stroke="#e5e7eb"
            strokeWidth={1}
          />
        ))}
        {x.ticks(4).map((t) => (
          <text
            key={t}
            x={x(t)}
            y={data.length * ROW + 10}
            textAnchor="middle"
            className="fill-gray-400 text-[8px]"
          >
            {formatValue(t, format)}
          </text>
        ))}
        {data.map((d) => (
          <g key={d.label} transform={`translate(0, ${y(d.label) ?? 0})`}>
            <rect
              width={Math.max(x(d.value), 0)}
              height={y.bandwidth()}
              rx={2}
              fill={d.color}
            >
              <title>{`${d.label}: ${formatValue(d.value, format)} (${formatShare(d.value, total)})`}</title>
            </rect>
            <text
              x={x(d.value) + 4}
              y={y.bandwidth() / 2}
              dominantBaseline="central"
              className="fill-gray-700 text-[9px] font-semibold"
            >
              {formatShare(d.value, total)}
            </text>
          </g>
        ))}
      </g>
      {data.map((d) => (
        <text
          key={d.label}
          x={LABEL_W - 6}
          y={(y(d.label) ?? 0) + y.bandwidth() / 2}
          textAnchor="end"
          dominantBaseline="central"
          className="fill-gray-600 text-[9px]"
        >
          <title>{d.label}</title>
          {d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label}
        </text>
      ))}
    </svg>
  );
}
