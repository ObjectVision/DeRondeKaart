import { For, Show, type JSX } from "solid-js";

import { Button } from "@/components/ui/button";
import { compareSelections, compareSlotColor } from "@/layers/compare-slots";

interface CompareBarProps {
  /** Opens the comparison panel — this is what pulls in the query engine. */
  onOpen: () => void;
  onClear: () => void;
}

/**
 * The bottom-centered "meer informatie" button, shown once at least one area is
 * selected. Also lists the selected areas in their slot colours, so the map's
 * dashed outlines can be read back to a name without opening the panel.
 */
export function CompareBar(props: CompareBarProps): JSX.Element {
  return (
    <Show when={compareSelections().length > 0}>
      <div class="pointer-events-auto flex items-center gap-2 rounded-full bg-white/95 px-3 py-1.5 shadow-md backdrop-blur-sm">
        <ul class="flex items-center gap-2">
          <For each={compareSelections()}>
            {(selection) => (
              <li class="flex items-center gap-1 text-xs text-gray-700">
                <span
                  class="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                  style={{ "background-color": compareSlotColor(selection.slot) }}
                />
                <span class="max-w-24 truncate">{selection.label}</span>
              </li>
            )}
          </For>
        </ul>
        <Button variant="ghost" onClick={() => props.onClear()} title="Selectie wissen">
          Wissen
        </Button>
        <Button onClick={() => props.onOpen()}>meer informatie</Button>
      </div>
    </Show>
  );
}
