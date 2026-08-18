import { For, Show, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, navIconSize } from "@/config/map-config";
import { NavTree } from "@/components/ui/navigation/NavTree";
import { withAlpha } from "@/lib/utils";
import { hasLeaves } from "@/layers/navigation";
import type { NavLeaf, NavNode } from "@/layers/navigation";

interface NavigationSectionProps {
  tree: NavNode[];
  isOpen: (path: string[]) => boolean;
  onToggle: (path: string[]) => void;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf) => void;
  leafDetail?: (leaf: NavLeaf) => JSX.Element;
  leafStatus?: (leaf: NavLeaf) => JSX.Element;
}

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
export function NavigationSection(props: NavigationSectionProps): JSX.Element {
  // Rows are keyed by label (unique across both shipped configs), so an expanding
  // theme can scroll itself into view.
  const rowRefs: Record<string, HTMLDivElement | undefined> = {};

  function handleToggle(label: string) {
    const wasOpen = props.isOpen([label]);
    props.onToggle([label]);
    // Expanding a theme near the bottom of the card would otherwise leave its
    // children below the fold. Deferred a frame so the children exist and the
    // row has its final height. "nearest" keeps an already-visible row still.
    if (!wasOpen) {
      requestAnimationFrame(() => {
        rowRefs[label]?.scrollIntoView({ block: "nearest" });
      });
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <h2 class="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Themas</h2>
      <ul class="flex flex-col gap-1">
        <For each={props.tree}>
          {(node) => {
            // A theme with no leaf anywhere beneath it has nothing to reveal, so
            // its row is disabled and stays collapsed regardless of stored state.
            const empty = !hasLeaves(node);
            const expanded = () => !empty && props.isOpen([node.label]);
            // Falls back to the UI-chrome accent rather than a hard-coded orange:
            // the expand chevron is chrome, not part of the theme's own identity,
            // so a theme without a color in navigation.json should match the rest
            // of the interface instead of introducing a second accent.
            const accent = node.color ?? chromeIconColor();
            return (
              <li>
                {/* Sticky so the theme name stays visible while scrolling a long
                    subtree — the largest theme has 63 leaves. Only meaningful
                    while expanded, so the offset is applied then. */}
                <div
                  ref={(el) => {
                    rowRefs[node.label] = el;
                  }}
                  class={
                    expanded() ? "sticky top-0 z-10 bg-white/95 backdrop-blur-sm" : undefined
                  }
                >
                  <Button
                    variant="ghost"
                    disabled={empty}
                    aria-expanded={empty ? undefined : expanded()}
                    class="h-auto w-full cursor-pointer flex-row items-center justify-start gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5 hover:bg-gray-50"
                    style={expanded() ? { "background-color": withAlpha(accent, 0.08) } : undefined}
                    onClick={() => handleToggle(node.label)}
                    title={empty ? `${node.label} (geen lagen beschikbaar)` : node.label}
                  >
                    <NavIcon
                      name={node.icon}
                      color={node.color}
                      size={navIconSize(24)}
                      class="flex-shrink-0"
                    />
                    {/* whitespace-normal is load-bearing: buttonVariants sets
                        whitespace-nowrap on the Button itself, so dropping the
                        truncate alone would leave the label on one overflowing
                        line rather than wrapping. */}
                    <span class="min-w-0 flex-1 whitespace-normal break-words text-left text-sm font-semibold text-gray-900">
                      {node.label}
                    </span>
                    {/* Rotates rather than pointing right: the row expands in
                        place now, it no longer navigates into a separate view. */}
                    <Icon
                      name={expanded() ? "expand_more" : "chevron_right"}
                      size={20}
                      color={accent}
                      class="flex-shrink-0"
                    />
                  </Button>
                </div>

                <Show when={expanded()}>
                  {/* Same indent guide BranchRow uses one level down, so nesting
                      reads identically at every depth. */}
                  <div class="ml-3 mt-1 border-l border-gray-100 pl-1">
                    <NavTree
                      items={node.children}
                      query=""
                      path={[node.label]}
                      isOpen={props.isOpen}
                      onToggle={props.onToggle}
                      selectedLeafId={props.selectedLeafId}
                      onSelectLeaf={props.onSelectLeaf}
                      leafDetail={props.leafDetail}
                      leafStatus={props.leafStatus}
                    />
                  </div>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </div>
  );
}
