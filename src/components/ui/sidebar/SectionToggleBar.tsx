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
  onToggle: () => void;
}

/**
 * A self-sized card of icon buttons that minimize/restore the sidebar sections.
 * Rendered as its own card below the zoom controls. Each button reflects its
 * section's state: highlighted when open, muted when minimized. Renders nothing
 * when there are no toggles.
 */
export function SectionToggleBar({ toggles }: { toggles: SectionToggle[] }) {
  if (toggles.length === 0) return null;

  return (
    <div className="flex flex-shrink-0 flex-col gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
      {toggles.map((t) => (
        <Button
          key={t.key}
          variant="ghost"
          size="icon-sm"
          onClick={t.onToggle}
          title={t.title}
          aria-label={t.title}
          aria-pressed={t.active}
        >
          <Icon
            name={t.icon}
            size={20}
            className={t.active ? "text-[#00498D]" : "text-gray-400"}
          />
        </Button>
      ))}
    </div>
  );
}
