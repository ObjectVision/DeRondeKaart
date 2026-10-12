import { createMemo, createSignal, type Accessor } from "solid-js";
import { isLeaf, type NavItem, type NavNode } from "@/layers/navigation";
import { branchToken } from "@/lib/nav-expansion-url";
import { readStorage, writeStorage } from "@/lib/storage";

const STORAGE_KEY = "nav-expansion";

/**
 * Identity of a branch in the navigation tree.
 *
 * `NavNode` has no id (only `NavLeaf` does), so the label path is the identity.
 * Verified unique across both shipped configs (68 and 25 branch paths, zero
 * duplicates). Path rather than array index so the state survives a
 * navigation.json edit and stays readable in devtools.
 */
export function pathKey(path: string[]): string {
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
  const raw = readStorage(sessionStorage, STORAGE_KEY);
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt blob is indistinguishable from no blob: start fresh.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  // Keep only booleans: a hand-edited or stale blob must not inject junk.
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "boolean") clean[k] = v;
  }
  return clean;
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
export function useNavExpansion(tree: Accessor<NavNode[]>): {
  isOpen: (path: string[]) => boolean;
  toggle: (path: string[]) => void;
  diffFromDefault: () => Record<string, boolean>;
  applyShared: (open: Set<string>, closed: Set<string>) => void;
} {
  // Overrides only — what the user has actually toggled this session. Kept
  // separate from the seed so a config change is picked up for untouched
  // branches instead of being masked by a stale snapshot.
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>(readStored());

  // `tree` is loaded once and cached by loadNavigation, but re-seeding is cheap
  // and keeps this correct if it ever changes.
  const seed = createMemo(() => seedFromTree(tree()));

  // Reads both signals, so a row calling this in its JSX re-runs when the user
  // toggles any branch — no subscription plumbing of its own.
  function isOpen(path: string[]) {
    const key = pathKey(path);
    return overrides()[key] ?? seed()[key] ?? false;
  }

  function toggle(path: string[]) {
    const key = pathKey(path);
    setOverrides((current) => {
      const now = current[key] ?? seed()[key] ?? false;
      const next = { ...current, [key]: !now };
      writeStorage(sessionStorage, STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  /**
   * What the user changed, relative to navigation.json — the payload of the
   * `nav` share parameter.
   *
   * Compared against the seed rather than returned raw, because `overrides`
   * keeps an entry for every branch ever toggled, including ones toggled back to
   * their configured state. Those are not changes and must not travel: a link
   * made after opening and re-closing a branch should carry no `nav` at all.
   */
  function diffFromDefault(): Record<string, boolean> {
    const current = overrides();
    const base = seed();
    const diff: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(current)) {
      if (value !== (base[key] ?? false)) diff[key] = value;
    }
    return diff;
  }

  /**
   * Apply a shared tree state, as token sets from the `nav` parameter.
   *
   * Tokens rather than paths because the sender's label paths are not in the
   * link — only their hashes — so resolution has to happen against the
   * recipient's own tree. A token matching no branch is SKIPPED, not an error:
   * that is what a renamed or deleted label looks like, and the branch simply
   * keeps its configured default. Rejecting the whole param over one rename
   * would throw away every other branch the link carried.
   *
   * Writes through to sessionStorage so the shared shape behaves exactly as if
   * the recipient had clicked those branches themselves.
   */
  function applyShared(open: Set<string>, closed: Set<string>) {
    if (open.size === 0 && closed.size === 0) return;

    const incoming: Record<string, boolean> = {};
    // Walks the CURRENT tree, so only branches that actually exist here can be
    // set — no need to validate the tokens separately.
    for (const key of Object.keys(seed())) {
      const token = branchToken(key);
      if (open.has(token)) incoming[key] = true;
      else if (closed.has(token)) incoming[key] = false;
    }
    if (Object.keys(incoming).length === 0) return;

    setOverrides((current) => {
      const next = { ...current, ...incoming };
      writeStorage(sessionStorage, STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { isOpen, toggle, diffFromDefault, applyShared };
}
