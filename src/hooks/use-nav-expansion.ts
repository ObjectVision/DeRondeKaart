import { useCallback, useMemo, useState } from "react";
import { isLeaf, type NavItem, type NavNode } from "@/layers/navigation";

const STORAGE_KEY = "nav-expansion";

/**
 * Identity of a branch in the navigation tree.
 *
 * `NavNode` has no id (only `NavLeaf` does), so the label path is the identity.
 * Verified unique across both shipped configs (68 and 25 branch paths, zero
 * duplicates). Path rather than array index so the state survives a
 * navigation.json edit and stays readable in devtools.
 */
function pathKey(path: string[]): string {
  return path.join(" / ");
}

/** Collect every branch's configured `expanded` into a path-keyed map. */
function seedFromTree(tree: NavNode[]): Record<string, boolean> {
  const seed: Record<string, boolean> = {};

  function walk(items: NavItem[], path: string[]) {
    for (const item of items) {
      if (isLeaf(item)) continue;
      const next = [...path, item.label];
      seed[pathKey(next)] = item.expanded ?? false;
      walk(item.children, next);
    }
  }

  walk(tree, []);
  return seed;
}

function readStored(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Keep only booleans: a hand-edited or stale blob must not inject junk.
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Session-remembered expand/collapse state for the navigation tree.
 *
 * State lives here rather than in each `BranchRow` because collapsing a branch
 * unmounts its whole subtree — local state would be destroyed every time, so a
 * reopened branch would forget which of its children had been open.
 *
 * The initial state of every branch comes from its `expanded` property in
 * navigation.json; anything the user has since toggled overrides it for the rest
 * of the session. A branch the stored blob doesn't know about (added by a config
 * edit mid-session) falls back to its configured value, so new content appears in
 * the state its author intended.
 *
 * sessionStorage, not localStorage: the tree returns to its configured shape in a
 * new tab, matching how the panel minimize flags behave (see use-session-flag.ts).
 */
export function useNavExpansion(tree: NavNode[]): {
  isOpen: (path: string[]) => boolean;
  toggle: (path: string[]) => void;
} {
  // Overrides only — what the user has actually toggled this session. Kept
  // separate from the seed so a config change is picked up for untouched
  // branches instead of being masked by a stale snapshot.
  const [overrides, setOverrides] = useState<Record<string, boolean>>(readStored);

  // `tree` is loaded once and cached by loadNavigation, but re-seeding is cheap
  // and keeps this correct if it ever changes identity.
  const seed = useMemo(() => seedFromTree(tree), [tree]);

  const isOpen = useCallback(
    (path: string[]) => {
      const key = pathKey(path);
      return overrides[key] ?? seed[key] ?? false;
    },
    [overrides, seed],
  );

  const toggle = useCallback(
    (path: string[]) => {
      const key = pathKey(path);
      setOverrides((current) => {
        const now = current[key] ?? seed[key] ?? false;
        const next = { ...current, [key]: !now };
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage failures (private mode / quota) — expansion still
          // works in-memory for this session.
        }
        return next;
      });
    },
    [seed],
  );

  return { isOpen, toggle };
}
