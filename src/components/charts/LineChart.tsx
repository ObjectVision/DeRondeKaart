import { area, line, curveMonotoneX } from "d3-shape";
import { scaleLinear, scalePoint } from "d3-scale";
import type { ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatValue } from "@/lib/format";

const WIDTH = 240;
const HEIGHT = 110;
const MARGIN = { top: 12, right: 34, bottom: 18, left: 40 };
const LINE_COLOR = "#1c5cab";

/** Line + area chart over an ordered dimension (datum labels = x ticks). */
export function LineChart({
  data,
  format,
}: {
  data: ChartDatum[];
  format: ChartValueFormat;
}) {
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const x = scalePoint<string>()
    .domain(data.map((d) => d.label))
    .range([0, plotW]);
  const y = scaleLinear()
    .domain([0, Math.max(...data.map((d) => d.value), 1)])
    .nice()
    .range([plotH, 0]);

  const linePath = line<ChartDatum>()
    .x((d) => x(d.label) ?? 0)
    .y((d) => y(d.value))
    .curve(curveMonotoneX);
  const areaPath = area<ChartDatum>()
    .x((d) => x(d.label) ?? 0)
    .y0(plotH)
    .y1((d) => y(d.value))
    .curve(curveMonotoneX);

  const last = data[data.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full">
      <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
        {y.ticks(3).map((t) => (
          <g key={t}>
            <line x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={-6} y={y(t)} textAnchor="end" dominantBaseline="central" className="fill-gray-400 text-[8px]">
              {formatValue(t, format)}
            </text>
          </g>
        ))}
        <path d={areaPath(data) ?? undefined} fill={LINE_COLOR} opacity={0.12} />
        <path d={linePath(data) ?? undefined} fill="none" stroke={LINE_COLOR} strokeWidth={2} />
        {data.map((d) => (
          <circle
            key={d.label}
            cx={x(d.label) ?? 0}
            cy={y(d.value)}
            r={4}
            fill={LINE_COLOR}
            stroke="#fff"
            strokeWidth={2}
          >
            <title>{`${d.label}: ${formatValue(d.value, format)}`}</title>
          </circle>
        ))}
        {last && (
          <text
            x={(x(last.label) ?? 0) + 6}
            y={y(last.value)}
            dominantBaseline="central"
            className="fill-gray-800 text-[9px] font-semibold"
          >
            {formatValue(last.value, format)}
          </text>
        )}
        {data.map((d) => (
          <text
            key={d.label}
            x={x(d.label) ?? 0}
            y={plotH + 12}
            textAnchor="middle"
            className="fill-gray-500 text-[8px]"
          >
            {d.label}
          </text>
        ))}
      </g>
    </svg>
  );
}
