import { useEffect, useState } from "react";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { NavTree } from "@/components/ui/navigation/NavTree";
import { LeafDetail } from "@/components/ui/navigation/LeafDetail";
import { FilterSection } from "./FilterSection";
import { NavigationSection } from "./NavigationSection";
import { loadNavigation, type NavLeaf, type NavNode } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";
import type { AreaFilterState } from "@/hooks/use-area-filter";
import { chromeIconSize } from "@/config/map-config";

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
  onClose,
  toolbar,
}: {
  nav: NavigationApi;
  areaFilter: AreaFilterState;
  /** Render the Filter section (false = minimized or disabled in config). */
  showFilter?: boolean;
  /** Render the Navigatie section (false = minimized or disabled in config). */
  showNavigation?: boolean;
  /** Close the whole navigation window (Filter + Navigatie together). */
  onClose?: () => void;
  /**
   * Toolbar row (search/zoom + section toggles) rendered above the sections.
   * Stays visible when both sections are minimized — it is how they are
   * restored.
   */
  toolbar?: React.ReactNode;
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
  const sectionsVisible = filterVisible || showNavigation;

  // Nothing at all to show — don't render an empty wrapper (and let map
  // clicks through). The toolbar alone still renders: it is how minimized
  // sections are restored.
  if (!sectionsVisible && !toolbar) return null;

  function selectCategory(index: number) {
    setActiveCategory((current) => (current === index ? null : index));
    setSelected(null);
  }

  return (
    // Column: toolbar row on top, then the sections card with the flyout as a
    // sibling (so the card's overflow doesn't clip it). The wrapper spans the
    // full height for max-h sizing but must not swallow map clicks around the
    // cards.
    <div className="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4 sm:top-4">
      {toolbar && (
        <div className="pointer-events-auto flex items-center gap-2">{toolbar}</div>
      )}

      <div className="flex min-h-0 flex-1 items-start">
        {sectionsVisible && (
          <div className="pointer-events-auto relative flex max-h-full w-72 flex-col gap-4 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
            {onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                title="Navigatie verbergen"
                aria-label="Navigatie verbergen"
                className="absolute right-2 top-2 z-10 h-5 w-5"
              >
                <Icon name="close" size={chromeIconSize()} className="text-gray-400" />
              </Button>
            )}
            {filterVisible && <FilterSection areaFilter={areaFilter} />}
            {showNavigation && (
              <NavigationSection
                tree={tree}
                activeCategory={activeCategory}
                onSelectCategory={selectCategory}
              />
            )}
          </div>
        )}

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
                  size={chromeIconSize()}
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
    </div>
  );
}
