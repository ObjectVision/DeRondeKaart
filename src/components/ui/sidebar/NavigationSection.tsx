import { Button } from "@/components/ui/button";
import { NavIcon } from "@/components/ui/nav-icon";
import { withAlpha } from "@/lib/utils";
import type { NavNode } from "@/layers/navigation";

/**
 * The "Navigatie" section of the sidebar: a grid of uniform, same-size
 * category buttons (the same categories as the top-center navigation bar).
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
      <div className="grid grid-cols-2 gap-2">
        {tree.map((node, index) => {
          const isActive = activeCategory === index;
          const accent = node.color ?? "#F97316"; // default orange
          return (
            <Button
              key={node.label}
              variant="ghost"
              aria-expanded={isActive}
              className="h-20 w-full cursor-pointer flex-col gap-1 rounded-xl border border-gray-100 bg-white px-1 py-2 hover:bg-gray-50"
              style={isActive ? { backgroundColor: withAlpha(accent, 0.08) } : undefined}
              onClick={() => onSelectCategory(index)}
              title={node.label}
            >
              <NavIcon name={node.icon} color={node.color} size={28} />
              <span className="w-full truncate text-center text-xs font-semibold text-gray-900">
                {node.label}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
