import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { NavTree } from "./NavTree";
import { LeafDetail } from "./LeafDetail";
import { loadNavigation, type NavLeaf, type NavNode } from "@/layers/navigation";
import type { NavigationApi } from "@/hooks/use-navigation";

interface SelectedLeaf {
  leaf: NavLeaf;
  path: string[];
}

// Button geometry, kept in sync with the className below so we can compute how
// many buttons fit in the available width.
const BUTTON_SIZE = 56; // size-14
const BUTTON_GAP = 8; // gap-2

export function NavigationPanel({ nav }: { nav: NavigationApi }) {
  const [tree, setTree] = useState<NavNode[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedLeaf | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // How many category buttons fit in the row at the current width.
  const rowRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(Infinity);

  useEffect(() => {
    loadNavigation()
      .then(setTree)
      .catch((err) => console.error("Failed to load navigation.json:", err));
  }, []);

  // Measure the row and compute how many buttons fit. Reserve one slot for the
  // overflow ("…") button whenever not everything fits.
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || tree.length === 0) return;

    function measure() {
      const width = el!.clientWidth;
      const perButton = BUTTON_SIZE + BUTTON_GAP;
      // How many fit if all are shown (no overflow button needed).
      const fitAll = Math.floor((width + BUTTON_GAP) / perButton);
      if (fitAll >= tree.length) {
        setVisibleCount(tree.length);
        return;
      }
      // Need an overflow button — reserve a slot for it.
      const fitWithOverflow = Math.max(0, Math.floor((width + BUTTON_GAP) / perButton) - 1);
      setVisibleCount(fitWithOverflow);
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tree.length]);

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
    return (
      <Button
        key={node.label}
        variant="ghost"
        size="icon"
        aria-expanded={isActive}
        className={
          "size-14 flex-shrink-0 cursor-pointer rounded-xl shadow-md backdrop-blur-sm " +
          (isActive ? "bg-orange-100 hover:bg-orange-100" : "bg-white/95 hover:bg-white")
        }
        onClick={() => {
          setActiveCategory(isActive ? null : index);
          setSelected(null);
          setOverflowOpen(false);
        }}
        title={node.label}
      >
        <NavIcon name={node.icon} color={node.color} size={32} />
      </Button>
    );
  }

  return (
    <div className="absolute left-1/2 top-2 z-30 flex w-[min(96vw,56rem)] -translate-x-1/2 flex-col gap-3 sm:top-4">
      {/* Search / question input */}
      <div className="flex items-center gap-4 rounded-full border border-gray-200/80 bg-white/95 px-7 py-[18px] shadow-md backdrop-blur-sm transition-shadow focus-within:border-gray-300 focus-within:shadow-lg">
        <Icon name="auto_awesome" size={28} className="flex-shrink-0 text-blue-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Zoek een kaartlaag…"
          className="min-w-0 flex-1 bg-transparent text-[22px] text-gray-700 outline-none placeholder:text-gray-400"
        />
        <Icon name="send" size={28} className="flex-shrink-0 text-gray-300" />
      </div>

      {/* Category icon row — never wider than the input; extras collapse into a
          "…" overflow button. */}
      <div className="relative">
        <div ref={rowRef} className="flex items-center gap-2 overflow-hidden">
          {visible.map((node) => renderCategoryButton(node, tree.indexOf(node)))}

          {overflow.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-expanded={overflowOpen}
              className={
                "size-14 flex-shrink-0 cursor-pointer rounded-xl shadow-md backdrop-blur-sm " +
                (overflowOpen ? "bg-gray-100 hover:bg-gray-100" : "bg-white/95 hover:bg-white")
              }
              onClick={() => setOverflowOpen((v) => !v)}
              title="Meer categorieën"
            >
              <Icon name="more_horiz" size={32} className="text-gray-500" />
            </Button>
          )}
        </div>

        {/* Overflow popover */}
        {overflowOpen && overflow.length > 0 && (
          <div className="absolute right-0 top-full z-10 mt-2 flex max-w-[min(96vw,56rem)] flex-wrap justify-end gap-2 rounded-2xl bg-white/95 p-2 shadow-md backdrop-blur-sm">
            {overflow.map((node) => renderCategoryButton(node, tree.indexOf(node)))}
          </div>
        )}
      </div>

      {/* Tree popover */}
      {(activeNode || searching) && !selected && (
        <div className="max-h-[50vh] overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-md backdrop-blur-sm">
          {activeNode && !searching && (
            <div className="mb-2 flex items-center gap-2 border-b border-gray-100 pb-2">
              <NavIcon
                name={activeNode.icon}
                color={activeNode.color}
                size={20}
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
          />
        </div>
      )}
    </div>
  );
}
