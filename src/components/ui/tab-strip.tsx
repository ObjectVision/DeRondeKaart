import { For, type JSX } from "solid-js";
import { chromeIconColor } from "@/config/map-config";

export interface Tab<Id extends string = string> {
  id: Id;
  label: string;
}

export interface TabStripProps<Id extends string = string> {
  tabs: readonly Tab<Id>[];
  active: Id;
  /**
   * `from` is the clicked button. Callers use it to find the scroll container
   * they live in — see the note on `role="dialog"` below.
   */
  onSelect: (id: Id, from: HTMLElement) => void;
}

/**
 * The tab strip both chrome dialogs use: "Over de applicatie" and the layer
 * metainfo window. Shared so the two cannot drift, since they sit in the same
 * dialog shell and are meant to read as one family.
 *
 * Three details are load-bearing rather than decorative:
 *
 * - The underline is ALWAYS laid out (`border-b-2 border-transparent`), so
 *   switching tabs recolors it instead of adding a border that nudges every
 *   label up by 2px.
 * - The negative margin with matching padding (`-mx-6 … px-6`) lets the bottom
 *   rule run the full width of the window rather than stopping at the dialog's
 *   own 24px padding.
 * - The active colour is an INLINE style, because `chromeIconColor()` is a
 *   runtime per-project value that no Tailwind class can carry.
 *
 * The labels take the same type spec as the dialog title above them, so the
 * window's two rows of chrome read as one and only colour marks the active tab.
 */
export function TabStrip<Id extends string>(props: TabStripProps<Id>): JSX.Element {
  return (
    <div class="-mx-6 mb-5 flex gap-0 border-b border-gray-200 px-6">
      <For each={props.tabs}>
        {(tab) => {
          const isActive = () => tab.id === props.active;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={isActive()}
              onClick={(e) => props.onSelect(tab.id, e.currentTarget)}
              class={`border-b-2 border-transparent px-2 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                isActive() ? "" : "text-gray-500 hover:text-gray-700"
              }`}
              style={
                isActive()
                  ? {
                      color: chromeIconColor(),
                      "border-bottom-color": chromeIconColor(),
                    }
                  : undefined
              }
            >
              {tab.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
