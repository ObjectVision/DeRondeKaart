import { useState } from "react";
import { NavIcon, Icon } from "@/components/ui/nav-icon";
import { isLeaf, type NavItem, type NavLeaf, type NavNode } from "@/layers/navigation";

interface NavTreeProps {
  items: NavItem[];
  /** Lowercased search query; "" means no filtering. */
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
}

/** Does this subtree contain a leaf whose label matches the query? */
function matches(item: NavItem, query: string): boolean {
  if (!query) return true;
  if (isLeaf(item)) return item.label.toLowerCase().includes(query);
  return item.children.some((c) => matches(c, query));
}

export function NavTree({ items, query, selectedLeafId, onSelectLeaf }: NavTreeProps) {
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
            />
          ) : (
            <BranchRow
              key={item.label}
              node={item}
              query={query}
              selectedLeafId={selectedLeafId}
              onSelectLeaf={(leaf, path) => onSelectLeaf(leaf, [item.label, ...path])}
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
}: {
  node: NavNode;
  query: string;
  selectedLeafId?: string;
  onSelectLeaf: (leaf: NavLeaf, path: string[]) => void;
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
}: {
  leaf: NavLeaf;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        onClick={onSelect}
        className={
          "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-7 text-left text-sm transition-colors hover:bg-gray-100 " +
          (selected ? "bg-blue-50 text-blue-700" : "text-gray-700")
        }
      >
        <NavIcon
          name={leaf.icon}
          color={leaf.color}
          size={18}
          className="flex-shrink-0 text-orange-400"
        />
        <span>{leaf.label}</span>
      </button>
    </li>
  );
}
