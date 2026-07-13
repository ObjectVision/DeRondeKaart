import { Icon } from "@/components/ui/nav-icon";
import type { ResolvedStat } from "@/layers/chart-data";
import { formatValue } from "@/lib/format";

/** One "Kerncijfers" statistic tile in the analytics panel. */
export function StatCard({ stat }: { stat: ResolvedStat }) {
  const { config, value } = stat;
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white p-2.5">
      <Icon name={config.icon} size={22} color={config.color ?? "#00498D"} />
      <div className="min-w-0">
        <div className="truncate text-lg font-bold text-gray-900">
          {formatValue(value, config.format)}
        </div>
        <div className="truncate text-[11px] text-gray-500" title={config.label}>
          {config.label}
        </div>
      </div>
    </div>
  );
}
