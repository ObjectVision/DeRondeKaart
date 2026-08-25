import { chromeIconColor } from "@/config/map-config";
import { loadConfig, clearConfigCache } from "@/config/load-config";

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
  /**
   * A prepared comparison: the layer for the left map and the layer for the
   * right map, applied together by a single click. Both must be present to
   * count as a pair — a leaf with neither is an ordinary single-layer leaf,
   * which is every leaf in the shipped configs today.
   *
   * Not to be confused with the `a`/`b` booleans above: those say nothing about
   * WHICH layer a side receives, which is why they could never express this.
   */
  left?: string;
  right?: string;
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

/** The two layer ids a paired leaf applies, or null for an ordinary leaf. */
export interface LeafPair {
  left: string;
  right: string;
}

/**
 * Read a leaf's prepared comparison, or null when it is an ordinary leaf.
 *
 * Both ids are required: half a pair would put one layer on one map and call it
 * a comparison, which is worse than not offering one.
 */
export function leafPair(leaf: NavLeaf): LeafPair | null {
  return leaf.left && leaf.right ? { left: leaf.left, right: leaf.right } : null;
}

/**
 * Whether a branch holds any selectable leaf, at any depth.
 *
 * False for the placeholder categories in navigation.json whose only child is
 * the empty leaf `pruneItems` drops, and for a branch holding nothing but such
 * categories. Those rows have nothing to reveal, so every navigation surface
 * renders them disabled instead of letting them expand onto an empty panel.
 */
export function hasLeaves(node: NavNode): boolean {
  return node.children.some((child) => (isLeaf(child) ? true : hasLeaves(child)));
}

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
  return loadConfig({
    name: "navigation.json",
    // No onError, for the same reason as layers.json: an empty tree is
    // indistinguishable from a project that configured no navigation.
    parse: (data) => {
      if (!Array.isArray(data)) {
        console.warn("navigation.json: expected a top-level array");
        return [];
      }
      return (data as NavNode[]).map((node) => ({
        ...node,
        children: pruneItems(node.children ?? []),
      }));
    },
  });
}

/** Drop the parsed navigation tree, for every variant. */
export function clearNavigationCache(): void {
  clearConfigCache("navigation.json");
}

/** Label of the injected theme holding user-created combination layers. */
export const COMBINATIONS_LABEL = "Combinaties";

/**
 * Append the "Combinaties" theme, holding the filter layers the user has
 * created, after the last top-level theme.
 *
 * Injected here rather than authored into navigation.json because the node is
 * dynamic — its children come and go with the session, while the JSON is static
 * config. Returns a NEW array: `loadNavigation` memoizes its result, and
 * appending in place would grow the cached tree on every call.
 *
 * The branch renders even with no children, so the user can find where their
 * combinations will appear — consistent with `pruneItems` leaving empty
 * categories in place. Until the first combination exists it is a leafless
 * branch like any other, so `hasLeaves` has every surface render it disabled.
 */
export function withCombinations(tree: NavNode[], leaves: NavLeaf[]): NavNode[] {
  return [
    ...tree,
    {
      label: COMBINATIONS_LABEL,
      icon: "masked_transitions_add",
      // Read at runtime rather than hard-coded: the themes in navigation.json
      // all carry the same accent as `chromeIconColor`, and this node is
      // injected rather than authored, so it has no JSON entry to state one.
      color: chromeIconColor(),
      expanded: true,
      children: leaves,
    },
  ];
}
