import { For, createUniqueId, type JSX } from "solid-js";
import { chromeIconColor } from "@/config/map-config";

export interface Tab<Id extends string = string> {
  id: Id;
  label: string;
}

export interface TabStripProps<Id extends string = string> {
  tabs: readonly Tab<Id>[];
  active: Id;
  /**
   * Wrapper classes, replacing the default. The default bleeds the bottom rule
   * through a dialog's 24px padding; somewhere with different padding — the
   * feature-info popup, whose PBL content has none — has to say so.
   */
  class?: string;
  /**
   * `from` is the clicked button. Callers use it to find the scroll container
   * they live in — see the note on `role="dialog"` below.
   */
  onSelect: (id: Id, from: HTMLElement) => void;
  /**
   * Id of the element holding the active tab's content, which should carry
   * `role="tabpanel"`. Wires `aria-controls` so assistive tech knows what each
   * tab governs.
   *
   * Optional because one caller (CombinationMeta) renders a single tab purely
   * as chrome, with no panel and an inert `onSelect`. Omitted there rather than
   * pointing at an element that does not exist.
   */
  panelId?: string;
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
 *   own 24px padding. It assumes that padding, so a host with different padding
 *   passes its own `class`.
 * - The active colour is an INLINE style, because `chromeIconColor()` is a
 *   runtime per-project value that no Tailwind class can carry.
 *
 * The labels take the same type spec as the dialog title above them, so the
 * window's two rows of chrome read as one and only colour marks the active tab.
 */
export function TabStrip<Id extends string>(props: TabStripProps<Id>): JSX.Element {
  /** Ids for the tab buttons, so a panel can point back with aria-labelledby. */
  const base = createUniqueId();
  const tabId = (id: Id) => `${base}-${id}`;

  let strip!: HTMLDivElement;

  /**
   * Arrow keys move between tabs, Home/End jump to the ends — the ARIA tabs
   * pattern, and required by WCAG 2.1.1 because a roving tabindex leaves only
   * ONE tab in the Tab order: without this the others are unreachable.
   *
   * Selection follows focus, which is the expected behaviour for tab panels
   * whose content is already loaded (all of ours are).
   */
  function handleKeyDown(event: KeyboardEvent) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const tabs = props.tabs;
    if (tabs.length < 2) return;

    const current = tabs.findIndex((t) => t.id === props.active);
    if (current === -1) return;

    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else {
      const step = event.key === "ArrowRight" ? 1 : -1;
      // Wraps, as the pattern specifies.
      next = (current + step + tabs.length) % tabs.length;
    }

    event.preventDefault();
    // Indexed off the rendered buttons rather than looked up by id: a tab id
    // comes from config (`META_ROUTES`, a project's own route names) and is not
    // guaranteed to be a valid CSS identifier, so a selector would need
    // `CSS.escape` — which is absent outside a browser and would throw here,
    // silently disabling the arrow keys.
    const buttons = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    const button = buttons[next];
    button?.focus();
    if (button) props.onSelect(tabs[next].id, button);
  }

  return (
    <div
      ref={strip}
      role="tablist"
      onKeyDown={handleKeyDown}
      class={props.class ?? "-mx-6 mb-5 flex gap-0 border-b border-gray-200 px-6"}
    >
      <For each={props.tabs}>
        {(tab) => {
          const isActive = () => tab.id === props.active;
          return (
            <button
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={isActive()}
              // Roving tabindex: Tab reaches the strip once and lands on the
              // ACTIVE tab, then the arrow keys move within it. Without this
              // every tab is its own stop, which the pattern explicitly avoids.
              tabindex={isActive() ? 0 : -1}
              // Only when the caller names a panel. A single-tab strip used as
              // chrome (CombinationMeta) has no panel to control, and pointing
              // at nothing would be worse than saying nothing.
              aria-controls={props.panelId}
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
