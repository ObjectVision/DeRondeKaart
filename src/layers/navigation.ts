/** A selectable layer in the navigation tree. */
export interface NavLeaf {
  /** Layer id matching an entry in layers.json. */
  id: string;
  label: string;
  /**
   * Icon reference: either a Material Symbols (Outlined) name ("groups",
   * "home") or a local SVG in `public/icons/` given by an `.svg` filename
   * ("woonzorganalyse.svg" → `/icons/woonzorganalyse.svg`). See nav-icon.tsx.
   */
  icon?: string;
  /** CSS color for the leaf icon, e.g. "#E0457B". */
  color?: string;
  /** Default-add to the left map / right map (informational; not auto-applied). */
  a?: boolean;
  b?: boolean;
  /** Path to an HTML metadata file, e.g. "/data/meta/huisarts.html". */
  meta?: string;
}

/** A category / sub-category branch in the navigation tree. */
export interface NavNode {
  label: string;
  /**
   * Icon reference: either a Material Symbols (Outlined) name ("groups",
   * "home") or a local SVG in `public/icons/` given by an `.svg` filename
   * ("woonzorganalyse.svg" → `/icons/woonzorganalyse.svg`). See nav-icon.tsx.
   */
  icon?: string;
  /** CSS color for the category icon, e.g. "#7C5CFC". */
  color?: string;
  expanded?: boolean;
  children: NavItem[];
}

export type NavItem = NavNode | NavLeaf;

/** Type guard: a leaf has an `id` and no `children`. */
export function isLeaf(item: NavItem): item is NavLeaf {
  return (item as NavNode).children === undefined;
}

let cachedNavigation: NavNode[] | null = null;

/**
 * Remove empty placeholder leaves (`id === "" && label === ""`) so empty
 * categories render cleanly, and recurse into sub-nodes.
 */
function pruneItems(items: NavItem[]): NavItem[] {
  const result: NavItem[] = [];
  for (const item of items) {
    if (isLeaf(item)) {
      if (item.id === "" && item.label === "") continue;
      result.push(item);
    } else {
      result.push({ ...item, children: pruneItems(item.children) });
    }
  }
  return result;
}

export async function loadNavigation(): Promise<NavNode[]> {
  if (cachedNavigation) return cachedNavigation;

  const response = await fetch("/navigation.json");
  if (!response.ok) {
    throw new Error(`Failed to load navigation.json: ${response.statusText}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    console.warn("navigation.json: expected a top-level array");
    cachedNavigation = [];
    return cachedNavigation;
  }

  cachedNavigation = (data as NavNode[]).map((node) => ({
    ...node,
    children: pruneItems(node.children ?? []),
  }));

  return cachedNavigation;
}
