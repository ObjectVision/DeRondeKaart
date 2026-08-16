import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { NavTree } from "./NavTree";
import { LeafDetail } from "./LeafDetail";
import { MapControls } from "@/components/ui/map-controls";
import { loadNavigation, withCombinations, type NavLeaf, type NavNode } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";
import { withAlpha } from "@/lib/utils";
import { chromeIconColor, chromeIconSize, navIconSize } from "@/config/map-config";

interface SelectedLeaf {
  leaf: NavLeaf;
  path: string[];
}

const BUTTON_GAP = 8; // gap-2

export const NavigationPanel = memo(function NavigationPanel({
  nav,
  onZoomIn,
  onZoomOut,
  showSearch = false,
  showNavigation = false,
  showControlsSearch = true,
  showControlsZoom = true,
  showCombinations = false,
  combinationLeaves,
  onOpenMeta,
}: {
  nav: NavigationApi;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Append the "Combinaties" theme (map.json `combinations`). */
  showCombinations?: boolean;
  /** Filter layers the user has created, shown under "Combinaties". */
  combinationLeaves?: NavLeaf[];
  /** Show the search bar. Defaults off (map.json `searchbar`). */
  showSearch?: boolean;
  /** Show the navigation controls (category row + zoom). Defaults off (map.json `navigation`). */
  showNavigation?: boolean;
  /** Show the location-search button in the MapControls card (map.json `mapControls.search`). */
  showControlsSearch?: boolean;
  /** Show the zoom +/- buttons in the MapControls card (map.json `mapControls.zoom`). */
  showControlsZoom?: boolean;
  /** Opens a layer's metainfo dialog from the info button in LeafDetail. */
  onOpenMeta?: (layerId: string, layerName: string) => void;
}) {
  const [loadedTree, setTree] = useState<NavNode[]>([]);
  // "Combinaties" is appended to the loaded tree rather than stored in it, so
  // the user's session-scoped filter layers stay out of the cached JSON. Every
  // use below — including the width measurement and the index-based category
  // selection — must see the same array, hence the derivation here.
  const tree = useMemo(
    () =>
      showCombinations ? withCombinations(loadedTree, combinationLeaves ?? []) : loadedTree,
    [showCombinations, loadedTree, combinationLeaves],
  );
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedLeaf | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // How many category buttons fit in the row at the current width. Buttons size
  // to their label width, so we measure off-screen renders of every button.
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(Infinity);

  useEffect(() => {
    loadNavigation()
      .then(setTree)
      .catch((err) => console.error("Failed to load navigation.json:", err));
  }, []);

  // Measure each button's actual width (from the hidden mirror row) and the
  // available width, then compute how many fit. Reserve room for the overflow
  // ("…") button whenever not everything fits.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const mirror = measureRef.current;
    if (!row || !mirror || tree.length === 0) return;

    function measure() {
      const avail = row!.clientWidth;
      // Mirror holds: [overflow button, ...category buttons] in source order.
      const children = Array.from(mirror!.children) as HTMLElement[];
      const overflowWidth = children[0]?.offsetWidth ?? 0;
      const widths = children.slice(1).map((c) => c.offsetWidth);

      // First check whether everything fits with no overflow button.
      let total = 0;
      for (let i = 0; i < widths.length; i++) {
        total += widths[i] + (i > 0 ? BUTTON_GAP : 0);
      }
      if (total <= avail) {
        setVisibleCount(tree.length);
        return;
      }

      // Otherwise fit as many as possible while leaving room for the overflow
      // button at the end.
      let used = overflowWidth + BUTTON_GAP;
      let count = 0;
      for (let i = 0; i < widths.length; i++) {
        const add = widths[i] + (count > 0 ? BUTTON_GAP : 0);
        if (used + add > avail) break;
        used += add;
        count++;
      }
      setVisibleCount(count);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    ro.observe(mirror);
    return () => ro.disconnect();
  }, [tree]);

  // Nothing to show if both surfaces are disabled, or the tree hasn't loaded.
  if (!showSearch && !showNavigation) return null;
  if (tree.length === 0) return null;

  const q = query.trim().toLowerCase();
  // When searching, show all categories' children flattened so matches surface
  // regardless of which category is active.
  const searching = q.length > 0;
  const activeNode = activeCategory !== null ? tree[activeCategory] : null;

  const visible = tree.slice(0, visibleCount);
  const overflow = tree.slice(visibleCount);

  function renderCategoryButton(node: NavNode, index: number) {
    const isActive = activeCategory === index;
    // Same fallback as the sidebar's theme rows: a theme with no color in
    // navigation.json takes the UI-chrome accent rather than a second one.
    const accent = node.color ?? chromeIconColor();
    return (
      <Button
        key={node.label}
        variant="ghost"
        size="icon"
        aria-expanded={isActive}
        className="h-auto w-auto flex-shrink-0 cursor-pointer flex-col gap-1 whitespace-nowrap rounded-xl bg-white/95 px-3 py-2 shadow-md backdrop-blur-sm hover:bg-white"
        style={isActive ? { backgroundColor: withAlpha(accent, 0.08) } : undefined}
        onClick={() => {
          setActiveCategory(isActive ? null : index);
          setSelected(null);
          setOverflowOpen(false);
        }}
        title={node.label}
      >
        <NavIcon name={node.icon} color={node.color} size={navIconSize(32)} />
        <span className="text-center text-sm font-semibold text-gray-900">
          {node.label}
        </span>
      </Button>
    );
  }

  function renderOverflowButton() {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-expanded={overflowOpen}
        className={
          "h-auto w-auto flex-shrink-0 cursor-pointer flex-col gap-1 whitespace-nowrap rounded-xl px-3 py-2 shadow-md backdrop-blur-sm " +
          (overflowOpen ? "bg-gray-100 hover:bg-gray-100" : "bg-white/95 hover:bg-white")
        }
        onClick={() => setOverflowOpen((v) => !v)}
        title="Meer categorieën"
      >
        <Icon name="more_horiz" size={32} className="text-gray-500" />
        <span className="text-center text-sm font-semibold text-gray-900">Meer</span>
      </Button>
    );
  }

  return (
    <div className="absolute left-1/2 top-2 z-30 flex w-[min(96vw,56rem)] -translate-x-1/2 flex-col gap-3 sm:top-4">
      {/* Search / question input */}
      {showSearch && (
        <div className="flex items-center gap-4 rounded-full border border-gray-200/80 bg-white/95 px-7 py-[18px] shadow-md backdrop-blur-sm transition-shadow focus-within:border-gray-300 focus-within:shadow-lg">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek een kaartlaag…"
            className="min-w-0 flex-1 bg-transparent text-[22px] text-gray-700 outline-none placeholder:text-gray-400"
          />
          <Icon name="send" size={28} className="flex-shrink-0 text-gray-300" />
        </div>
      )}

      {/* Navigation controls (zoom +/- and the category icon row); their combined
          height matches the icon buttons via items-stretch. The tree/leaf
          popovers below open from these controls, so they share the gate. */}
      {showNavigation && (
      <>
      <div className="flex items-stretch gap-2">
        <MapControls
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          showSearch={showControlsSearch}
          showZoom={showControlsZoom}
        />

        {/* Category icon row — never wider than the input; extras collapse into a
            "…" overflow button. */}
        <div className="relative min-w-0 flex-1">
        <div ref={rowRef} className="flex items-stretch gap-2 overflow-hidden">
          {visible.map((node) => renderCategoryButton(node, tree.indexOf(node)))}
          {overflow.length > 0 && renderOverflowButton()}
        </div>

        {/* Hidden mirror used only for measuring intrinsic button widths.
            Order: overflow button first, then every category button. */}
        <div
          ref={measureRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0 flex items-stretch gap-2"
        >
          {renderOverflowButton()}
          {tree.map((node) => renderCategoryButton(node, tree.indexOf(node)))}
        </div>

        {/* Overflow popover */}
        {overflowOpen && overflow.length > 0 && (
          <div className="absolute right-0 top-full z-10 mt-2 flex max-w-[min(96vw,56rem)] flex-wrap justify-end gap-2 rounded-2xl bg-white/95 p-2 shadow-md backdrop-blur-sm">
            {overflow.map((node) => renderCategoryButton(node, tree.indexOf(node)))}
          </div>
        )}
        </div>
      </div>

      {/* Tree popover */}
      {(activeNode || searching) && !selected && (
        <div className="max-h-[50vh] overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
          {activeNode && !searching && (
            <div className="mb-2 flex items-center gap-2 border-b border-gray-100 pb-2">
              <NavIcon
                name={activeNode.icon}
                color={activeNode.color}
                size={chromeIconSize()}
                className="text-orange-500"
              />
              <span className="text-sm font-semibold text-gray-900">{activeNode.label}</span>
            </div>
          )}
          <NavTree
            items={searching ? tree : activeNode!.children}
            query={q}
            onSelectLeaf={(leaf, path) => setSelected({ leaf, path })}
          />
        </div>
      )}

      {/* Leaf detail popover */}
      {selected && (
        <div className="max-h-[50vh] overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
          <LeafDetail
            leaf={selected.leaf}
            path={selected.path}
            nav={nav}
            onBack={() => setSelected(null)}
            onOpenMeta={onOpenMeta}
          />
        </div>
      )}
      </>
      )}
    </div>
  );
});
