import { For, Show, createSignal, type JSX } from "solid-js";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { hasLeaves, isLeaf, type NavItem, type NavLeaf, type NavNode } from "@/layers/navigation";
import { chromeIconColor } from "@/config/map-config";

interface NavTreeProps {
  items: NavItem[];
  /** Lowercased search query; "" means no filtering. */
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
  /**
   * Label path of the node these items hang under, used to build each branch's
   * identity for `isOpen`/`onToggle`. Empty at the root; the sidebar passes the
   * theme's label so branch keys match the tree as a whole.
   */
  path?: string[];
  /**
   * Controlled expansion. Supply BOTH to lift branch open/closed state out of
   * the rows (the sidebar does, so state survives a branch unmounting and
   * persists for the session — see use-nav-expansion.ts). Omit both and each
   * branch keeps its own local state seeded from `node.expanded` — a transient
   * view that resets when the branch unmounts.
   */
  isOpen?: (path: string[]) => boolean;
  onToggle?: (path: string[]) => void;
  /**
   * Actions rendered to the RIGHT of a leaf row (the sidebar's three-button
   * menu) — always visible on the selected row, shown on hover for the rest.
   * When omitted, selecting a leaf is the caller's business entirely.
   */
  leafActions?: (leaf: NavLeaf) => JSX.Element;
  /** Panel rendered below the SELECTED leaf row (the sidebar's info panel). */
  leafDetail?: (leaf: NavLeaf) => JSX.Element;
  /**
   * Status element rendered at the right edge of EVERY leaf row (e.g. the
   * on-map check button). Rendered outside the label button, so it may be
   * interactive itself.
   */
  leafStatus?: (leaf: NavLeaf) => JSX.Element;
}

/** Does this subtree contain a leaf whose label matches the query? */
function matches(item: NavItem, query: string): boolean {
  if (!query) return true;
  if (isLeaf(item)) return item.label.toLowerCase().includes(query);
  return item.children.some((c) => matches(c, query));
}

export function NavTree(props: NavTreeProps): JSX.Element {
  const path = () => props.path ?? [];
  const visible = () => props.items.filter((item) => matches(item, props.query));

  return (
    <ul class="flex flex-col gap-0.5">
      <For each={visible()}>
        {(item) => (
          <Show
            when={!isLeaf(item) ? (item as NavNode) : null}
            fallback={
              <LeafRow
                leaf={item as NavLeaf}
                selected={(item as NavLeaf).id === props.selectedLeafId}
                onSelect={() => props.onSelectLeaf(item as NavLeaf, [item.label])}
                actions={props.leafActions?.(item as NavLeaf)}
                detail={
                  (item as NavLeaf).id === props.selectedLeafId
                    ? props.leafDetail?.(item as NavLeaf)
                    : undefined
                }
                status={props.leafStatus?.(item as NavLeaf)}
              />
            }
          >
            {(node) => (
              <BranchRow
                node={node()}
                query={props.query}
                selectedLeafId={props.selectedLeafId}
                onSelectLeaf={(leaf, leafPath) =>
                  props.onSelectLeaf(leaf, [node().label, ...leafPath])
                }
                path={[...path(), node().label]}
                isOpen={props.isOpen}
                onToggle={props.onToggle}
                leafActions={props.leafActions}
                leafDetail={props.leafDetail}
                leafStatus={props.leafStatus}
              />
            )}
          </Show>
        )}
      </For>
    </ul>
  );
}

interface BranchRowProps {
  node: NavNode;
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
  path: string[];
  isOpen?: (path: string[]) => boolean;
  onToggle?: (path: string[]) => void;
  leafActions?: (leaf: NavLeaf) => JSX.Element;
  leafDetail?: (leaf: NavLeaf) => JSX.Element;
  leafStatus?: (leaf: NavLeaf) => JSX.Element;
}

function BranchRow(props: BranchRowProps): JSX.Element {
  // Used only in the uncontrolled case; harmless otherwise.
  // deliberate one-time seed: a row
  // is re-created when its node changes, and `expanded` is the initial state only
  // eslint-disable-next-line solid/reactivity
  const [localOpen, setLocalOpen] = createSignal(props.node.expanded ?? false);
  const controlled = () => props.isOpen !== undefined && props.onToggle !== undefined;
  const open = () => (controlled() ? props.isOpen!(props.path) : localOpen());
  // A branch with nothing under it stays collapsed whatever the stored state or
  // `node.expanded` says — its row is disabled, so the user could not close it
  // again.
  const empty = () => !hasLeaves(props.node);
  // A non-empty query force-expands matching branches. Deliberately does NOT
  // write through to the controlled state: clearing the search must return the
  // tree to what the user actually left open, not to all-expanded.
  const expanded = () => !empty() && (props.query ? true : open());

  return (
    <li>
      <button
        onClick={() => (controlled() ? props.onToggle!(props.path) : setLocalOpen((v) => !v))}
        disabled={empty()}
        aria-expanded={empty() ? undefined : expanded()}
        class={
          "flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors " +
          (empty() ? "cursor-default opacity-50" : "hover:bg-gray-100")
        }
      >
        <Icon
          name={expanded() ? "expand_more" : "chevron_right"}
          size={18}
          color={chromeIconColor()}
          class="mt-px flex-shrink-0"
        />
        <NavIcon
          name={props.node.icon}
          color={props.node.color}
          size={18}
          class="mt-px flex-shrink-0 text-gray-500"
        />
        <span class={"break-words font-medium " + (empty() ? "text-gray-400" : "text-gray-800")}>
          {props.node.label}
        </span>
      </button>
      <Show when={expanded()}>
        <div class="ml-3 border-l border-gray-100 pl-1">
          <NavTree
            items={props.node.children}
            query={props.query}
            selectedLeafId={props.selectedLeafId}
            onSelectLeaf={props.onSelectLeaf}
            path={props.path}
            isOpen={props.isOpen}
            onToggle={props.onToggle}
            leafActions={props.leafActions}
            leafDetail={props.leafDetail}
            leafStatus={props.leafStatus}
          />
        </div>
      </Show>
    </li>
  );
}

interface LeafRowProps {
  leaf: NavLeaf;
  selected: boolean;
  onSelect: () => void;
  /** Inline menu right of the row: always shown while selected, on hover otherwise. */
  actions?: JSX.Element;
  /** Panel shown below the row while it is selected (info). */
  detail?: JSX.Element;
  /** Always-visible indicator after the label (e.g. on-map check). */
  status?: JSX.Element;
}

function LeafRow(props: LeafRowProps): JSX.Element {
  return (
    <li>
      <div
        class={
          "group flex w-full items-center gap-1 rounded pr-1 transition-colors hover:bg-gray-100 " +
          (props.selected ? "bg-blue-50" : "")
        }
      >
        <button
          onClick={() => props.onSelect?.()}
          aria-expanded={props.actions ? props.selected : undefined}
          class={
            "flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1 pl-7 text-left text-sm " +
            (props.selected ? "text-blue-700" : "text-gray-700")
          }
        >
          {/* items-start, not items-center: a label that wraps to two lines would
              otherwise centre the icon against the whole block, belonging to
              neither line. mt-px centres the 18px icon on the 20px first line. */}
          <NavIcon
            name={props.leaf.icon}
            color={props.leaf.color}
            size={18}
            class="mt-px flex-shrink-0 text-orange-400"
          />
          {/* Wraps rather than truncating: labels that differ only in their tail
              ("… <10%", "… <20%") are indistinguishable once elided. break-words
              catches a long unbroken token, which would widen the fixed-width
              panel instead. */}
          <span class="break-words">{props.leaf.label}</span>
        </button>
        {/* The action menu's map buttons already reflect the on-map state, so
            the status check is redundant (and would duplicate) while the menu
            is visible on hover. */}
        <Show when={props.status}>
          <div class={props.actions ? "group-hover:hidden" : undefined}>{props.status}</div>
        </Show>
        <Show when={props.actions}>
          <div class={props.selected ? "flex" : "hidden group-hover:flex"}>{props.actions}</div>
        </Show>
      </div>
      <Show when={props.selected}>{props.detail}</Show>
    </li>
  );
}
