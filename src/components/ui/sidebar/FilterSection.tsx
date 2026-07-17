import { MultiSelect } from "@/components/ui/multi-select";
import type { AreaFilterState } from "@/hooks/use-area-filter";

/**
 * The "Filter" section of the sidebar: one multi-select per filter.json entry
 * (Gemeente / Wijk / Buurt), with options cascaded coarse-to-fine.
 */
export function FilterSection({ areaFilter }: { areaFilter: AreaFilterState }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Gebieden
      </h2>
      {areaFilter.entries.map((entry) => {
        const enabled = areaFilter.isEnabled(entry);
        const placeholder = enabled
          ? entry.placeholder
          : `Kies eerst ${(entry.dependsOn ?? []).join(" en ")}`;
        return (
          <MultiSelect
            key={entry.key}
            placeholder={placeholder}
            disabled={!enabled}
            options={areaFilter.optionsFor(entry)}
            selected={areaFilter.selections.get(entry.key) ?? new Set()}
            onToggle={(code) => areaFilter.toggleValue(entry.key, code)}
            onClear={() => areaFilter.clearLevel(entry.key)}
          />
        );
      })}
    </div>
  );
}
