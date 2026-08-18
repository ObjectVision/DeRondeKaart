import { For, type JSX } from "solid-js";
import { SingleSelect } from "@/components/ui/single-select";
import type { AreaFilterState } from "@/hooks/use-area-filter";

interface FilterSectionProps {
  areaFilter: AreaFilterState;
}

/**
 * The "Filter" section of the sidebar: one single-selection combobox per
 * filter.json entry (Gemeente / Wijk / Buurt), cascaded coarse-to-fine.
 */
export function FilterSection(props: FilterSectionProps): JSX.Element {
  return (
    <div class="flex flex-col gap-1.5">
      <h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Gebieden
      </h2>
      <For each={props.areaFilter.entries()}>
        {(entry) => {
          const selectedCode = () => {
            const selected = props.areaFilter.selections().get(entry.key);
            return selected && selected.size > 0 ? [...selected][0] : null;
          };
          return (
            <SingleSelect
              placeholder={entry.placeholder}
              disabled={!props.areaFilter.isEnabled(entry)}
              options={props.areaFilter.optionsFor(entry)}
              selectedCode={selectedCode()}
              onSelect={(code) => props.areaFilter.setValue(entry.key, code)}
            />
          );
        }}
      </For>
    </div>
  );
}
