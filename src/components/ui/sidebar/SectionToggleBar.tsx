import { For, Show, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

export interface SectionToggle {
  /** Stable key identifying the section. */
  key: string;
  /** Material Symbols icon name, e.g. "filter_alt" / "layers". */
  icon: string;
  /** Tooltip / aria label. */
  title: string;
  /** Whether the section is currently expanded (icon highlighted). */
  active: boolean;
  /** Greyed out and not clickable (e.g. the section has nothing to show). */
  disabled?: boolean;
  onToggle: () => void;
}

interface SectionToggleBarProps {
  toggles: SectionToggle[];
  /** "vertical" (default) stacks the buttons; "horizontal" lays them out as a row. */
  orientation?: "vertical" | "horizontal";
}

/**
 * A self-sized card of icon buttons that minimize/restore the sidebar sections.
 * Rendered as its own card below the zoom controls. Each button reflects its
 * section's state: highlighted when open, muted when minimized. Renders nothing
 * when there are no toggles.
 */
export function SectionToggleBar(props: SectionToggleBarProps): JSX.Element {
  return (
    <Show when={props.toggles.length > 0}>
      <div
        class={`flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm ${
          (props.orientation ?? "vertical") === "horizontal" ? "flex-row" : "flex-col"
        }`}
      >
        <For each={props.toggles}>
          {(t) => (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={t.onToggle}
              title={t.title}
              aria-label={t.title}
              aria-pressed={t.active}
              disabled={t.disabled}
            >
              <Icon
                name={t.icon}
                size={chromeIconSize()}
                color={t.disabled ? undefined : chromeIconColor()}
                class={t.disabled ? "text-gray-300" : undefined}
              />
            </Button>
          )}
        </For>
      </div>
    </Show>
  );
}
