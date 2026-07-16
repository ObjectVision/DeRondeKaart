import { memo, useEffect, useState } from "react";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { Button } from "@/components/ui/button";
import { NavTree } from "@/components/ui/navigation/NavTree";
import { LeafMeta } from "@/components/ui/navigation/LeafMeta";
import { FilterSection } from "./FilterSection";
import { NavigationSection } from "./NavigationSection";
import { loadNavigation, type NavLeaf, type NavNode } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";
import type { AreaFilterState } from "@/hooks/use-area-filter";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

/**
 * Permanent on-map state toggle shown at the right edge of every layer row.
 * `circle` when the layer is on neither map (click adds it to the left map);
 * `check_circle` when it is on the left and/or right map (click removes it from
 * every map it is on). The rest of the row handles add/meta — see handleRowClick.
 */
function LeafStateToggle({ leaf, nav }: { leaf: NavLeaf; nav: NavigationApi }) {
  const onA = nav.isOnMap(leaf.id, "a");
  const onB = nav.isOnMap(leaf.id, "b");
  const onMap = onA || onB;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="flex-shrink-0"
      onClick={(e) => {
        // Keep the row's own click handler from also firing.
        e.stopPropagation();
        if (onMap) {
          // Remove from every map the layer is on.
          if (onA) nav.toggleOnMap(leaf.id, "a");
          if (onB) nav.toggleOnMap(leaf.id, "b");
        } else {
          nav.toggleOnMap(leaf.id, "a"); // always add to the left map
        }
      }}
      title={onMap ? "Verwijder van kaart" : "Toon op linker kaart"}
      aria-label={onMap ? `Verwijder ${leaf.label} van kaart` : `Toon ${leaf.label} op linker kaart`}
      aria-pressed={onMap}
    >
      <Icon
        name={onMap ? "check_circle" : "circle"}
        size={chromeIconSize()}
        color={chromeIconColor()}
      />
    </Button>
  );
}

/**
 * Left sidebar (map.json `navigationMode: "sidebar"`): the Filter section on
 * top of a Navigatie grid of category buttons. Clicking a category overlays
 * that category's content tree over the Navigatie section (inside the same
 * card, with a back header). Each layer row carries a permanent on-map state
 * toggle (LeafStateToggle); clicking the rest of the row adds the layer and/or
 * toggles its meta info panel below the row (see handleRowClick).
 */
export const Sidebar = memo(function Sidebar({
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
  // The row whose meta info panel is currently open (null = none open).
  const [metaOpenLeafId, setMetaOpenLeafId] = useState<string | null>(null);

  useEffect(() => {
    loadNavigation()
      .then(setTree)
      .catch((err) => console.error("Failed to load navigation.json:", err));
  }, []);

  const filterVisible = showFilter && areaFilter.entries.length > 0;
  // The category tree only makes sense while the Navigatie section is shown.
  const activeNode = showNavigation && activeCategory !== null ? tree[activeCategory] : null;
  const sectionsVisible = filterVisible || showNavigation;

  // Nothing at all to show — don't render an empty wrapper (and let map
  // clicks through). The toolbar alone still renders: it is how minimized
  // sections are restored.
  if (!sectionsVisible && !toolbar) return null;

  function selectCategory(index: number) {
    setActiveCategory((current) => (current === index ? null : index));
    setMetaOpenLeafId(null);
  }

  function closeCategory() {
    setActiveCategory(null);
    setMetaOpenLeafId(null);
  }

  // Row click (anywhere except the on-map state toggle). One combined gesture:
  //  - layer not on any map → add it to the left map; open its meta if any.
  //  - layer on a map, meta open → close the meta.
  //  - layer on a map, meta closed → (re)open the meta if any.
  function handleRowClick(leaf: NavLeaf) {
    const onMap = nav.isOnMap(leaf.id, "a") || nav.isOnMap(leaf.id, "b");
    const hasMeta = Boolean(leaf.meta);

    if (!onMap) {
      nav.toggleOnMap(leaf.id, "a");
      setMetaOpenLeafId(hasMeta ? leaf.id : null);
      return;
    }

    // Already on a map: the row toggles the meta panel.
    setMetaOpenLeafId((prev) =>
      prev === leaf.id ? null : hasMeta ? leaf.id : null,
    );
  }

  return (
    // Column: toolbar row on top, then the sections card. The wrapper spans
    // the full height for max-h sizing but must not swallow map clicks around
    // the cards.
    <div className="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4 sm:top-4">
      {toolbar && (
        <div className="pointer-events-auto flex items-center gap-2">{toolbar}</div>
      )}

      <div className="flex min-h-0 flex-1 items-start">
        {sectionsVisible && (
          // Capped at half the viewport height — longer content (category
          // trees, info panels) scrolls inside the card.
          <div className="app-scrollbar pointer-events-auto relative flex max-h-[50vh] w-72 flex-col gap-4 overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
            {onClose && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                title="Navigatie verbergen"
                aria-label="Navigatie verbergen"
                className="absolute right-2 top-2 z-10 h-5 w-5"
              >
                <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            )}
            {filterVisible && <FilterSection areaFilter={areaFilter} />}
            {showNavigation &&
              (activeNode ? (
                // Category content tree — overlays the Navigatie section in
                // the same card slot; the back header restores the grid.
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 border-b border-gray-100 pb-2">
                    <button
                      onClick={closeCategory}
                      className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100"
                      title="Terug naar thema's"
                      aria-label="Terug naar thema's"
                    >
                      <Icon name="arrow_back" size={16} />
                    </button>
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
                    selectedLeafId={metaOpenLeafId ?? undefined}
                    onSelectLeaf={handleRowClick}
                    leafDetail={(leaf) => (
                      <div className="ml-7 mt-0.5 max-h-48 overflow-y-auto rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
                        <LeafMeta leaf={leaf} />
                      </div>
                    )}
                    leafStatus={(leaf) => <LeafStateToggle leaf={leaf} nav={nav} />}
                  />
                </div>
              ) : (
                <NavigationSection
                  tree={tree}
                  activeCategory={activeCategory}
                  onSelectCategory={selectCategory}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
});
