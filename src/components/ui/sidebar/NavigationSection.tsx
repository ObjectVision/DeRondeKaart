import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { navIconSize } from "@/config/map-config";
import { NavTree } from "@/components/ui/navigation/NavTree";
import { withAlpha } from "@/lib/utils";
import type { NavLeaf, NavNode } from "@/layers/navigation";

/**
 * The "Navigatie" section of the sidebar: a treeview whose top level is the
 * category rows (the same categories as the top-center navigation bar).
 *
 * Expanding a theme reveals its branches and leaves INLINE, directly beneath its
 * row, with the sibling themes left in place below. That in-place expansion is
 * the point: the previous design swapped the whole grid out for a single
 * category's tree behind a back-header, which lost the user's sense of where
 * they were. Icon and accent color both come from navigation.json
 * (`node.icon`/`node.color`).
 *
 * Expansion state is owned by the caller (see use-nav-expansion.ts) so it
 * survives a theme collapsing — which unmounts its whole subtree — and persists
 * for the session.
 */
export function NavigationSection({
  tree,
  isOpen,
  onToggle,
  selectedLeafId,
  onSelectLeaf,
  leafDetail,
  leafStatus,
}: {
  tree: NavNode[];
  isOpen: (path: string[]) => boolean;
  onToggle: (path: string[]) => void;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf) => void;
  leafDetail?: (leaf: NavLeaf) => React.ReactNode;
  leafStatus?: (leaf: NavLeaf) => React.ReactNode;
}) {
  // Rows are keyed by label (unique across both shipped configs), so an expanding
  // theme can scroll itself into view.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const handleToggle = useCallback(
    (label: string) => {
      const wasOpen = isOpen([label]);
      onToggle([label]);
      // Expanding a theme near the bottom of the card would otherwise leave its
      // children below the fold. Deferred a frame so the children exist and the
      // row has its final height. "nearest" keeps an already-visible row still.
      if (!wasOpen) {
        requestAnimationFrame(() => {
          rowRefs.current[label]?.scrollIntoView({ block: "nearest" });
        });
      }
    },
    [isOpen, onToggle],
  );

  return (
    <div className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Themas
      </h2>
      <ul className="flex flex-col gap-1">
        {tree.map((node) => {
          const expanded = isOpen([node.label]);
          const accent = node.color ?? "#F97316"; // default orange
          return (
            <li key={node.label}>
              {/* Sticky so the theme name stays visible while scrolling a long
                  subtree — the largest theme has 63 leaves. Only meaningful
                  while expanded, so the offset is applied then. */}
              <div
                ref={(el) => {
                  rowRefs.current[node.label] = el;
                }}
                className={expanded ? "sticky top-0 z-10 bg-white/95 backdrop-blur-sm" : undefined}
              >
                <Button
                  variant="ghost"
                  aria-expanded={expanded}
                  className="h-auto w-full cursor-pointer flex-row items-center justify-start gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5 hover:bg-gray-50"
                  style={expanded ? { backgroundColor: withAlpha(accent, 0.08) } : undefined}
                  onClick={() => handleToggle(node.label)}
                  title={node.label}
                >
                  <NavIcon
                    name={node.icon}
                    color={node.color}
                    size={navIconSize(24)}
                    className="flex-shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-gray-900">
                    {node.label}
                  </span>
                  {/* Rotates rather than pointing right: the row expands in
                      place now, it no longer navigates into a separate view. */}
                  <Icon
                    name={expanded ? "expand_more" : "chevron_right"}
                    size={20}
                    color={accent}
                    className="flex-shrink-0"
                  />
                </Button>
              </div>

              {expanded && (
                // Same indent guide BranchRow uses one level down, so nesting
                // reads identically at every depth.
                <div className="ml-3 mt-1 border-l border-gray-100 pl-1">
                  <NavTree
                    items={node.children}
                    query=""
                    path={[node.label]}
                    isOpen={isOpen}
                    onToggle={onToggle}
                    selectedLeafId={selectedLeafId}
                    onSelectLeaf={onSelectLeaf}
                    leafDetail={leafDetail}
                    leafStatus={leafStatus}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
