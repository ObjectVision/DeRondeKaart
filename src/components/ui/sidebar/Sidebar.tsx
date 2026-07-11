import { useEffect, useState } from "react";
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
 * Three-button menu shown to the right of a selected layer row: draw on the
 * left map, draw on the right map (only once the left map holds a layer),
 * and toggle the layer's meta info (rendered below the row via leafDetail).
 * Replaces the old LeafDetail flyout in sidebar mode. All icons follow the
 * chrome icon color; only the disabled right-map button greys out.
 */
function LeafActionMenu({
  leaf,
  nav,
  infoOpen,
  onToggleInfo,
}: {
  leaf: NavLeaf;
  nav: NavigationApi;
  infoOpen: boolean;
  onToggleInfo: () => void;
}) {
  const onA = nav.isOnMap(leaf.id, "a");
  const onB = nav.isOnMap(leaf.id, "b");
  // Adding to the right map requires a layer on the left first; removing an
  // existing right-map layer stays allowed (same rule as LeafDetail).
  const rightDisabled = !nav.leftHasLayers && !onB;
  // No meta configured for this layer — nothing to show.
  const infoDisabled = !leaf.meta;

  const iconProps = (disabled = false) => ({
    size: chromeIconSize(),
    color: disabled ? undefined : chromeIconColor(),
    className: disabled ? "text-gray-300" : undefined,
  });

  return (
    <div className="flex flex-shrink-0 gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => nav.toggleOnMap(leaf.id, "a")}
        title={onA ? "Verwijder van linker kaart" : "Toon op linker kaart"}
        aria-label={onA ? "Verwijder van linker kaart" : "Toon op linker kaart"}
        aria-pressed={onA}
      >
        {/* Reflect on-map state: check while the layer is on the left map. */}
        <Icon name={onA ? "check_circle" : "arrow_circle_left"} {...iconProps()} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={rightDisabled}
        onClick={() => nav.toggleOnMap(leaf.id, "b")}
        title={
          rightDisabled
            ? "Voeg eerst een laag toe aan de linker kaart"
            : onB
              ? "Verwijder van rechter kaart"
              : "Toon op rechter kaart"
        }
        aria-label={onB ? "Verwijder van rechter kaart" : "Toon op rechter kaart"}
        aria-pressed={onB}
      >
        {/* Reflect on-map state: check while the layer is on the right map. */}
        <Icon
          name={onB ? "check_circle" : "arrow_circle_right"}
          {...iconProps(rightDisabled)}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={infoDisabled}
        onClick={onToggleInfo}
        title={infoDisabled ? "Geen informatie beschikbaar" : "Informatie"}
        aria-label="Informatie"
        aria-pressed={infoOpen}
      >
        <Icon name="info" {...iconProps(infoDisabled)} />
      </Button>
    </div>
  );
}

/**
 * Left sidebar (map.json `navigationMode: "sidebar"`): the Filter section on
 * top of a Navigatie grid of category buttons. Clicking a category overlays
 * that category's content tree over the Navigatie section (inside the same
 * card, with a back header); clicking a layer expands the inline
 * LeafActionMenu below its row.
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
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

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
    setSelectedLeafId(null);
    setInfoOpen(false);
  }

  function closeCategory() {
    setActiveCategory(null);
    setSelectedLeafId(null);
    setInfoOpen(false);
  }

  function handleSelectLeaf(leaf: NavLeaf) {
    setSelectedLeafId((prev) => (prev === leaf.id ? null : leaf.id));
    setInfoOpen(false);
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
                    selectedLeafId={selectedLeafId ?? undefined}
                    onSelectLeaf={handleSelectLeaf}
                    leafActions={(leaf) => (
                      <LeafActionMenu
                        leaf={leaf}
                        nav={nav}
                        infoOpen={infoOpen}
                        onToggleInfo={() => setInfoOpen((v) => !v)}
                      />
                    )}
                    leafDetail={(leaf) =>
                      infoOpen ? (
                        <div className="ml-7 mt-0.5 max-h-48 overflow-y-auto rounded-lg bg-gray-50 p-2 text-sm leading-relaxed text-gray-600">
                          <LeafMeta leaf={leaf} />
                        </div>
                      ) : null
                    }
                    leafStatus={(leaf) => {
                      // The selected row shows the action menu, whose buttons
                      // already reflect the on-map state — skip the check there.
                      if (leaf.id === selectedLeafId) return null;
                      const onA = nav.isOnMap(leaf.id, "a");
                      const onB = nav.isOnMap(leaf.id, "b");
                      if (!onA && !onB) return null;
                      return (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="flex-shrink-0"
                          onClick={() => {
                            // Remove from every map the layer is on.
                            if (onA) nav.toggleOnMap(leaf.id, "a");
                            if (onB) nav.toggleOnMap(leaf.id, "b");
                          }}
                          title="Verwijder van kaart"
                          aria-label={`Verwijder ${leaf.label} van kaart`}
                        >
                          <Icon
                            name="check_circle"
                            size={chromeIconSize()}
                            color={chromeIconColor()}
                          />
                        </Button>
                      );
                    }}
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
}
