import type { JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";
import type { ResolvedStat } from "@/layers/chart-data";
import { formatValue } from "@/lib/format";

interface StatCardProps {
  stat: ResolvedStat;
}

/** One "Kerncijfers" statistic tile in the analytics panel. */
export function StatCard(props: StatCardProps): JSX.Element {
  return (
    <div class="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-white p-2.5">
      <Icon
        name={props.stat.config.icon}
        size={22}
        color={props.stat.config.color ?? "#00498D"}
      />
      <div class="min-w-0">
        <div class="truncate text-lg font-bold text-gray-900">
          {formatValue(props.stat.value, props.stat.config.format)}
        </div>
        <div class="truncate text-[11px] text-gray-500" title={props.stat.config.label}>
          {props.stat.config.label}
        </div>
      </div>
    </div>
  );
}
