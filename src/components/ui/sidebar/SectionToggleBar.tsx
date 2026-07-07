import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";

export interface SectionToggle {
  /** Stable key for React. */
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

/**
 * A self-sized card of icon buttons that minimize/restore the sidebar sections.
 * Rendered as its own card below the zoom controls. Each button reflects its
 * section's state: highlighted when open, muted when minimized. Renders nothing
 * when there are no toggles.
 */
export function SectionToggleBar({
  toggles,
  orientation = "vertical",
}: {
  toggles: SectionToggle[];
  /** "vertical" (default) stacks the buttons; "horizontal" lays them out as a row. */
  orientation?: "vertical" | "horizontal";
}) {
  if (toggles.length === 0) return null;

  return (
    <div
      className={`flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm ${
        orientation === "horizontal" ? "flex-row" : "flex-col"
      }`}
    >
      {toggles.map((t) => (
        <Button
          key={t.key}
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
            size={20}
            className={
              t.disabled
                ? "text-gray-300"
                : t.active
                  ? "text-[#00498D]"
                  : "text-gray-400"
            }
          />
        </Button>
      ))}
    </div>
  );
}
