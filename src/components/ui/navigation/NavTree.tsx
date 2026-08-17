import { useState } from "react";
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
   * branch keeps its own local state seeded from `node.expanded`, which is what
   * the top-mode popover wants: a transient view that resets when reopened.
   */
  isOpen?: (path: string[]) => boolean;
  onToggle?: (path: string[]) => void;
  /**
   * Actions rendered to the RIGHT of a leaf row (the sidebar's three-button
   * menu) — always visible on the selected row, shown on hover for the rest.
   * When omitted, selecting a leaf is the caller's business entirely (top
   * mode opens LeafDetail instead).
   */
  leafActions?: (leaf: NavLeaf) => React.ReactNode;
  /** Panel rendered below the SELECTED leaf row (the sidebar's info panel). */
  leafDetail?: (leaf: NavLeaf) => React.ReactNode;
  /**
   * Status element rendered at the right edge of EVERY leaf row (e.g. the
   * on-map check button). Rendered outside the label button, so it may be
   * interactive itself.
   */
  leafStatus?: (leaf: NavLeaf) => React.ReactNode;
}

/** Does this subtree contain a leaf whose label matches the query? */
function matches(item: NavItem, query: string): boolean {
  if (!query) return true;
  if (isLeaf(item)) return item.label.toLowerCase().includes(query);
  return item.children.some((c) => matches(c, query));
}

export function NavTree({
  items,
  query,
  selectedLeafId,
  onSelectLeaf,
  path = [],
  isOpen,
  onToggle,
  leafActions,
  leafDetail,
  leafStatus,
}: NavTreeProps) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items
        .filter((item) => matches(item, query))
        .map((item) =>
          isLeaf(item) ? (
            <LeafRow
              key={item.id || item.label}
              leaf={item}
              selected={item.id === selectedLeafId}
              onSelect={() => onSelectLeaf(item, [item.label])}
              actions={leafActions?.(item)}
              detail={item.id === selectedLeafId ? leafDetail?.(item) : undefined}
              status={leafStatus?.(item)}
            />
          ) : (
            <BranchRow
              key={item.label}
              node={item}
              query={query}
              selectedLeafId={selectedLeafId}
              onSelectLeaf={(leaf, leafPath) => onSelectLeaf(leaf, [item.label, ...leafPath])}
              path={[...path, item.label]}
              isOpen={isOpen}
              onToggle={onToggle}
              leafActions={leafActions}
              leafDetail={leafDetail}
              leafStatus={leafStatus}
            />
          ),
        )}
    </ul>
  );
}

function BranchRow({
  node,
  query,
  selectedLeafId,
  onSelectLeaf,
  path,
  isOpen,
  onToggle,
  leafActions,
  leafDetail,
  leafStatus,
}: {
  node: NavNode;
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
  path: string[];
  isOpen?: (path: string[]) => boolean;
  onToggle?: (path: string[]) => void;
  leafActions?: (leaf: NavLeaf) => React.ReactNode;
  leafDetail?: (leaf: NavLeaf) => React.ReactNode;
  leafStatus?: (leaf: NavLeaf) => React.ReactNode;
}) {
  // Always declared (hooks can't be conditional); ignored when controlled.
  const [localOpen, setLocalOpen] = useState(node.expanded ?? false);
  const controlled = isOpen !== undefined && onToggle !== undefined;
  const open = controlled ? isOpen(path) : localOpen;
  // A branch with nothing under it stays collapsed whatever the stored state or
  // `node.expanded` says — its row is disabled, so the user could not close it
  // again.
  const empty = !hasLeaves(node);
  // A non-empty query force-expands matching branches. Deliberately does NOT
  // write through to the controlled state: clearing the search must return the
  // tree to what the user actually left open, not to all-expanded.
  const expanded = !empty && (query ? true : open);

  return (
    <li>
      <button
        onClick={() => (controlled ? onToggle(path) : setLocalOpen((v) => !v))}
        disabled={empty}
        aria-expanded={empty ? undefined : expanded}
        className={
          "flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors " +
          (empty ? "cursor-default opacity-50" : "hover:bg-gray-100")
        }
      >
        <Icon
          name={expanded ? "expand_more" : "chevron_right"}
          size={18}
          color={chromeIconColor()}
          className="mt-px flex-shrink-0"
        />
        <NavIcon
          name={node.icon}
          color={node.color}
          size={18}
          className="mt-px flex-shrink-0 text-gray-500"
        />
        <span
          className={
            "break-words font-medium " + (empty ? "text-gray-400" : "text-gray-800")
          }
        >
          {node.label}
        </span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-gray-100 pl-1">
          <NavTree
            items={node.children}
            query={query}
            selectedLeafId={selectedLeafId}
            onSelectLeaf={onSelectLeaf}
            path={path}
            isOpen={isOpen}
            onToggle={onToggle}
            leafActions={leafActions}
            leafDetail={leafDetail}
            leafStatus={leafStatus}
          />
        </div>
      )}
    </li>
  );
}

function LeafRow({
  leaf,
  selected,
  onSelect,
  actions,
  detail,
  status,
}: {
  leaf: NavLeaf;
  selected: boolean;
  onSelect: () => void;
  /** Inline menu right of the row: always shown while selected, on hover otherwise. */
  actions?: React.ReactNode;
  /** Panel shown below the row while it is selected (info). */
  detail?: React.ReactNode;
  /** Always-visible indicator after the label (e.g. on-map check). */
  status?: React.ReactNode;
}) {
  return (
    <li>
      <div
        className={
          "group flex w-full items-center gap-1 rounded pr-1 transition-colors hover:bg-gray-100 " +
          (selected ? "bg-blue-50" : "")
        }
      >
        <button
          onClick={onSelect}
          aria-expanded={actions ? selected : undefined}
          className={
            "flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1 pl-7 text-left text-sm " +
            (selected ? "text-blue-700" : "text-gray-700")
          }
        >
          {/* items-start, not items-center: a label that wraps to two lines would
              otherwise centre the icon against the whole block, belonging to
              neither line. mt-px centres the 18px icon on the 20px first line. */}
          <NavIcon
            name={leaf.icon}
            color={leaf.color}
            size={18}
            className="mt-px flex-shrink-0 text-orange-400"
          />
          {/* Wraps rather than truncating: labels that differ only in their tail
              ("… <10%", "… <20%") are indistinguishable once elided. break-words
              catches a long unbroken token, which would widen the fixed-width
              panel instead. */}
          <span className="break-words">{leaf.label}</span>
        </button>
        {/* The action menu's map buttons already reflect the on-map state, so
            the status check is redundant (and would duplicate) while the menu
            is visible on hover. */}
        {status && (
          <div className={actions ? "group-hover:hidden" : undefined}>{status}</div>
        )}
        {actions && (
          <div className={selected ? "flex" : "hidden group-hover:flex"}>{actions}</div>
        )}
      </div>
      {selected && detail}
    </li>
  );
}
