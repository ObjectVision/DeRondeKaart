import { arc, pie, type PieArcDatum } from "d3-shape";
import type { ChartDatum } from "@/layers/chart-data";
import type { ChartValueFormat } from "@/layers/types";
import { formatShare, formatValue } from "@/lib/format";

const SIZE = 120;
const R = SIZE / 2;

/** Donut with a formatted total in the center and an HTML legend at right. */
export function DonutChart({
  data,
  total,
  format,
}: {
  data: ChartDatum[];
  total: number;
  format: ChartValueFormat;
}) {
  const arcs = pie<ChartDatum>()
    .value((d) => d.value)
    .sort(null)
    .padAngle(0.02)(data);
  const arcPath = arc<PieArcDatum<ChartDatum>>()
    .innerRadius(R * 0.62)
    .outerRadius(R - 1);

  return (
    <div className="flex items-center gap-3">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-28 flex-shrink-0">
        <g transform={`translate(${R}, ${R})`}>
          {arcs.map((a) => (
            <path
              key={a.data.label}
              d={arcPath(a) ?? undefined}
              fill={a.data.color}
              stroke="#fff"
              strokeWidth={2}
            >
              <title>{`${a.data.label}: ${formatValue(a.data.value, format)} (${formatShare(a.data.value, total)})`}</title>
            </path>
          ))}
          <text
            textAnchor="middle"
            dy="-0.1em"
            className="fill-gray-900 text-[15px] font-bold"
          >
            {formatValue(total, format)}
          </text>
          <text textAnchor="middle" dy="1.2em" className="fill-gray-400 text-[9px]">
            totaal
          </text>
        </g>
      </svg>
      <ul className="flex min-w-0 flex-1 flex-col gap-px">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-1 text-[10px] leading-tight">
            <span
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: d.color }}
            />
            <span className="min-w-0 flex-1 truncate text-gray-600" title={d.label}>
              {d.label}
            </span>
            <span className="flex-shrink-0 font-semibold text-gray-800">
              {formatShare(d.value, total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
