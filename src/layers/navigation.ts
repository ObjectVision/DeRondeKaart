import { chromeIconColor } from "@/config/map-config";
import { configPath, variantCacheKey } from "@/config/variant";

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
 * Parsed navigation.json per config variant (key from `variantCacheKey`, ""
 * when the project declares no variants). Both variants stay cached so a
 * switch back is instant — see the note on the equivalent map in `config.ts`.
 */
const cachedNavigations = new globalThis.Map<string, NavNode[]>();

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
  const key = variantCacheKey("navigation.json");
  const cached = cachedNavigations.get(key);
  if (cached) return cached;

  const response = await fetch(configPath("navigation.json"));
  if (!response.ok) {
    throw new Error(`Failed to load navigation.json: ${response.statusText}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    console.warn("navigation.json: expected a top-level array");
    cachedNavigations.set(key, []);
    return [];
  }

  const tree = (data as NavNode[]).map((node) => ({
    ...node,
    children: pruneItems(node.children ?? []),
  }));
  cachedNavigations.set(key, tree);

  return tree;
}

/** Drop the parsed navigation tree for one variant, or all of them. */
export function clearNavigationCache(variant?: string): void {
  if (variant === undefined) cachedNavigations.clear();
  else cachedNavigations.delete(variant);
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
