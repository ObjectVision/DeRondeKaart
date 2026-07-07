import { MultiSelect } from "@/components/ui/multi-select";
import type { AreaFilterState } from "@/hooks/use-area-filter";

/**
 * The "Filter" section of the sidebar: one multi-select per filter.json entry
 * (Gemeente / Wijk / Buurt), with options cascaded coarse-to-fine.
 */
export function FilterSection({ areaFilter }: { areaFilter: AreaFilterState }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Gebieden
      </h2>
      {areaFilter.entries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-1">
          <label className="px-1 text-xs font-medium text-gray-600">{entry.name}</label>
          <MultiSelect
            placeholder={entry.placeholder}
            options={areaFilter.optionsFor(entry)}
            selected={areaFilter.selections.get(entry.key) ?? new Set()}
            onToggle={(code) => areaFilter.toggleValue(entry.key, code)}
            onClear={() => areaFilter.clearLevel(entry.key)}
          />
        </div>
      ))}
    </div>
  );
}
