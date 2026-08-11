import { SingleSelect } from "@/components/ui/single-select";
import type { AreaFilterState } from "@/hooks/use-area-filter";

interface FilterSectionProps {
  areaFilter: AreaFilterState;
}

/**
 * The "Filter" section of the sidebar: one single-selection combobox per
 * filter.json entry (Gemeente / Wijk / Buurt), cascaded coarse-to-fine.
 */
export function FilterSection({ areaFilter }: FilterSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Gebieden
      </h2>
      {areaFilter.entries.map((entry) => {
        const enabled = areaFilter.isEnabled(entry);
        const placeholder = entry.placeholder
        const selected = areaFilter.selections.get(entry.key);
        const selectedCode = selected && selected.size > 0 ? [...selected][0] : null;
        return (
          <SingleSelect
            key={entry.key}
            placeholder={placeholder}
            disabled={!enabled}
            options={areaFilter.optionsFor(entry)}
            selectedCode={selectedCode}
            onSelect={(code) => areaFilter.setValue(entry.key, code)}
          />
        );
      })}
    </div>
  );
}
