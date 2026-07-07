import { useEffect, useState } from "react";
import { NavIcon } from "@/components/ui/nav-icon";
import { NavTree } from "@/components/ui/navigation/NavTree";
import { LeafDetail } from "@/components/ui/navigation/LeafDetail";
import { FilterSection } from "./FilterSection";
import { NavigationSection } from "./NavigationSection";
import { loadNavigation, type NavLeaf, type NavNode } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";
import type { AreaFilterState } from "@/hooks/use-area-filter";

interface SelectedLeaf {
  leaf: NavLeaf;
  path: string[];
}

/**
 * Left sidebar (map.json `navigationMode: "sidebar"`): the Filter section on
 * top of a Navigatie grid of category buttons. Clicking a category opens a
 * flyout to the right of the sidebar with its branches/leaves (the same
 * NavTree/LeafDetail as the top-center navigation).
 */
export function Sidebar({
  nav,
  areaFilter,
  showFilter = true,
  showNavigation = true,
}: {
  nav: NavigationApi;
  areaFilter: AreaFilterState;
  /** Render the Filter section (false = minimized or disabled in config). */
  showFilter?: boolean;
  /** Render the Navigatie section (false = minimized or disabled in config). */
  showNavigation?: boolean;
}) {
  const [tree, setTree] = useState<NavNode[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [selected, setSelected] = useState<SelectedLeaf | null>(null);

  useEffect(() => {
    loadNavigation()
      .then(setTree)
      .catch((err) => console.error("Failed to load navigation.json:", err));
  }, []);

  const filterVisible = showFilter && areaFilter.entries.length > 0;
  // The category flyout only makes sense while the Navigatie section is shown.
  const activeNode = showNavigation && activeCategory !== null ? tree[activeCategory] : null;

  // Nothing to show — don't render an empty card (and let map clicks through).
  if (!filterVisible && !showNavigation) return null;

  function selectCategory(index: number) {
    setActiveCategory((current) => (current === index ? null : index));
    setSelected(null);
  }

  return (
    // The flyout is a sibling of the (scrollable) sidebar card so the card's
    // overflow doesn't clip it. The wrapper spans the full height for max-h
    // sizing but must not swallow map clicks below the card.
    <div className="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex items-start sm:bottom-4 sm:left-4 sm:top-4">
      <div className="pointer-events-auto flex max-h-full w-72 flex-col gap-4 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
        {filterVisible && <FilterSection areaFilter={areaFilter} />}
        {showNavigation && (
          <NavigationSection
            tree={tree}
            activeCategory={activeCategory}
            onSelectCategory={selectCategory}
          />
        )}
      </div>

      {activeNode && (
        <div className="pointer-events-auto ml-2 max-h-full w-80 self-start overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
          {selected ? (
            <LeafDetail
              leaf={selected.leaf}
              path={selected.path}
              nav={nav}
              onBack={() => setSelected(null)}
            />
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2 border-b border-gray-100 pb-2">
                <NavIcon
                  name={activeNode.icon}
                  color={activeNode.color}
                  size={20}
                  className="text-orange-500"
                />
                <span className="text-sm font-semibold text-gray-900">
                  {activeNode.label}
                </span>
              </div>
              <NavTree
                items={activeNode.children}
                query=""
                onSelectLeaf={(leaf, path) => setSelected({ leaf, path })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
