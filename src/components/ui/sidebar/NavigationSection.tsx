import { Button } from "@/components/ui/button";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { withAlpha } from "@/lib/utils";
import type { NavNode } from "@/layers/navigation";

/**
 * The "Navigatie" section of the sidebar: a vertical list of category rows
 * (the same categories as the top-center navigation bar). Each row shows the
 * category icon and label with a chevron, and opens that category's tree.
 * Icon and accent color both come from navigation.json (`node.icon`/`node.color`).
 */
export function NavigationSection({
  tree,
  activeCategory,
  onSelectCategory,
}: {
  tree: NavNode[];
  activeCategory: number | null;
  onSelectCategory: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Themas
      </h2>
      <div className="flex flex-col gap-1">
        {tree.map((node, index) => {
          const isActive = activeCategory === index;
          const accent = node.color ?? "#F97316"; // default orange
          return (
            <Button
              key={node.label}
              variant="ghost"
              aria-expanded={isActive}
              className="h-auto w-full cursor-pointer flex-row items-center justify-start gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5 hover:bg-gray-50"
              style={isActive ? { backgroundColor: withAlpha(accent, 0.08) } : undefined}
              onClick={() => onSelectCategory(index)}
              title={node.label}
            >
              <NavIcon name={node.icon} color={node.color} size={24} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-gray-900">
                {node.label}
              </span>
              <Icon
                name="chevron_right"
                size={20}
                color={accent}
                className="flex-shrink-0"
              />
            </Button>
          );
        })}
      </div>
    </div>
  );
}
