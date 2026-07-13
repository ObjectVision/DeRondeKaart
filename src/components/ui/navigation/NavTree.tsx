import { useState } from "react";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { isLeaf, type NavItem, type NavLeaf, type NavNode } from "@/layers/navigation";

interface NavTreeProps {
  items: NavItem[];
  /** Lowercased search query; "" means no filtering. */
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
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
              onSelectLeaf={(leaf, path) => onSelectLeaf(leaf, [item.label, ...path])}
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
  leafActions,
  leafDetail,
  leafStatus,
}: {
  node: NavNode;
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
  leafActions?: (leaf: NavLeaf) => React.ReactNode;
  leafDetail?: (leaf: NavLeaf) => React.ReactNode;
  leafStatus?: (leaf: NavLeaf) => React.ReactNode;
}) {
  const [open, setOpen] = useState(node.expanded ?? false);
  // A non-empty query force-expands matching branches.
  const expanded = query ? true : open;

  return (
    <li>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-gray-100"
      >
        <Icon
          name={expanded ? "expand_more" : "chevron_right"}
          size={18}
          className="flex-shrink-0 text-gray-400"
        />
        <NavIcon
          name={node.icon}
          color={node.color}
          size={18}
          className="flex-shrink-0 text-gray-500"
        />
        <span className="font-medium text-gray-800">{node.label}</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-gray-100 pl-1">
          <NavTree
            items={node.children}
            query={query}
            selectedLeafId={selectedLeafId}
            onSelectLeaf={onSelectLeaf}
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
            "flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 pl-7 text-left text-sm " +
            (selected ? "text-blue-700" : "text-gray-700")
          }
        >
          <NavIcon
            name={leaf.icon}
            color={leaf.color}
            size={18}
            className="flex-shrink-0 text-orange-400"
          />
          <span className="truncate">{leaf.label}</span>
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
