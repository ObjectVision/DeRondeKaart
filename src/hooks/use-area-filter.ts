import { createSignal, onMount, onCleanup, type Accessor } from "solid-js";
import { loadParquetBatches } from "@/layers";
import {
  loadAreaFilterConfig,
  setAreaFilterSelection,
  type AreaFilterEntry,
} from "@/layers/area-filter";
import { extendRowBbox, type BBox } from "@/layers/box-filter";
import { flyToBbox } from "@/lib/fly-to";

/** One selectable value in a filter dropdown. */
export interface AreaFilterOption {
  /** The raw code, e.g. "WK088200". */
  code: string;
  /** Display text (the entry's label field, or the code when it's missing). */
  label: string;
  /** Other known code fields present on the row, e.g. { gm_code: "GM0882" }. */
  parents: Record<string, string>;
}

export interface AreaFilterState {
  entries: Accessor<AreaFilterEntry[]>;
  /**
   * Options for a dropdown, narrowed by coarser selections (cascade).
   * `against` overrides which selection map does the narrowing — needed when a
   * caller is building an end-state map that hasn't been committed yet (see
   * App's host-filter handler); defaults to the committed selections.
   */
  optionsFor(
    entry: AreaFilterEntry,
    against?: Map<string, Set<string>>,
  ): AreaFilterOption[];
  /**
   * Whether the entry's `dependsOn` filters all have a selection. When false
   * the control must be disabled: the user cannot select a value yet.
   */
  isEnabled(entry: AreaFilterEntry): boolean;
  /**
   * Selected codes per key field. Single-selection: each level holds at most
   * one code (kept as a Set so the store/predicate layer stays unchanged).
   */
  selections: Accessor<Map<string, Set<string>>>;
  /** Select a single value for a level, or clear it with `null`. */
  setValue(key: string, code: string | null): void;
  clearLevel(key: string): void;
  /**
   * Replace the whole selection map at once (annotation snapshot restore; host
   * filter messages). Commits through the same prune + module-store path as
   * setValue. Flies only with `{ fly: true }` — the snapshot restore carries its
   * own camera, while a host filter message wants the usual fly-to.
   *
   * Prefer this over looping setValue: setValue rebuilds from the current
   * `selections`, so N calls in one synchronous pass each discard the
   * previous one's result (last write wins, for both the commit and the fly-to).
   */
  applySelections(next: Map<string, Set<string>>, opts?: { fly?: boolean }): void;
}

/** Known CBS code columns that can appear as parent references on options. */
const PARENT_FIELDS = ["gm_code", "wk_code", "bu_code"];

function digitsOf(code: string): string {
  return code.replace(/^\D+/, "");
}

function digitsMatch(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Extract deduplicated options (code, label, parent codes) from a table. */
function extractOptions(
  table: { getChild(name: string): { get(i: number): unknown; length: number } | null },
  entry: AreaFilterEntry,
): AreaFilterOption[] | null {
  const codeCol = table.getChild(entry.key);
  if (!codeCol) {
    console.warn(
      `filter.json: key field "${entry.key}" not found in ${entry.source}; skipping "${entry.name}"`,
    );
    return null;
  }
  const labelCol = table.getChild(entry.label);
  if (!labelCol) {
    console.warn(
      `filter.json: label field "${entry.label}" not found in ${entry.source}; falling back to codes`,
    );
  }
  const parentCols = PARENT_FIELDS.filter((f) => f !== entry.key)
    .map((field) => ({ field, col: table.getChild(field) }))
    .filter((p) => p.col !== null);

  const byCode = new Map<string, AreaFilterOption>();
  for (let i = 0; i < codeCol.length; i++) {
    const raw = codeCol.get(i);
    if (raw === null || raw === undefined) continue;
    const code = String(raw);
    if (byCode.has(code)) continue;

    const labelValue = labelCol?.get(i);
    const parents: Record<string, string> = {};
    for (const { field, col } of parentCols) {
      const value = col!.get(i);
      if (value !== null && value !== undefined) parents[field] = String(value);
    }
    byCode.set(code, {
      code,
      label: labelValue !== null && labelValue !== undefined ? String(labelValue) : code,
      parents,
    });
  }
  const options = [...byCode.values()];
  options.sort((a, b) => a.label.localeCompare(b.label, "nl"));
  return options;
}

/**
 * Are all of `entry`'s `dependsOn` filters satisfied (each has a non-empty
 * selection)? Dependencies reference filters by `name`; unknown names are
 * ignored so a stale config never permanently locks a filter.
 */
function dependenciesSatisfied(
  entry: AreaFilterEntry,
  entries: AreaFilterEntry[],
  selections: Map<string, Set<string>>,
): boolean {
  const deps = entry.dependsOn ?? [];
  return deps.every((depName) => {
    const dep = entries.find((e) => e.name === depName);
    if (!dep) return true;
    const selected = selections.get(dep.key);
    return selected !== undefined && selected.size > 0;
  });
}

/**
 * Clear the selection of every filter whose dependencies are no longer
 * satisfied, so a disabled dropdown never keeps filtering the map. Mutates
 * `selection` in place. Iterating coarse-to-fine propagates the effect down a
 * chain in a single pass (dependencies always point at earlier entries).
 */
function pruneDisabledSelections(
  selection: Map<string, Set<string>>,
  entries: AreaFilterEntry[],
): void {
  for (const entry of entries) {
    if ((entry.dependsOn?.length ?? 0) === 0) continue;
    if (!dependenciesSatisfied(entry, entries, selection)) {
      selection.set(entry.key, new Set());
    }
  }
}

/** Does an option belong to any of the selected ancestor codes? */
function optionMatchesAncestor(
  option: AreaFilterOption,
  ancestorKey: string,
  selectedCodes: Set<string>,
): boolean {
  const parent = option.parents[ancestorKey];
  if (parent !== undefined) return selectedCodes.has(parent);
  // Generic fallback when the parent field is absent: CBS codes nest by digits.
  const optionDigits = digitsOf(option.code);
  return [...selectedCodes].some((code) => digitsMatch(digitsOf(code), optionDigits));
}

/**
 * Fly to the bbox of the FINEST level with a selection: walk that level's
 * (cached) table, extend the bbox with the geometry of every selected row,
 * and dispatch through the shared fly-to system. No selection → stay put.
 *
 * `onBbox` additionally reports the framed bbox to the caller. The `map:flyto`
 * event only reaches MOUNTED MapViews, and the circular-only view renders
 * without any (App early-returns before them), so in that mode the event has no
 * listener and the camera would never move. App uses this callback to drive its
 * own viewState instead — see the `onFlyToBbox` option below.
 */
async function flyToSelection(
  entries: AreaFilterEntry[],
  selection: Map<string, Set<string>>,
  onBbox?: (bbox: BBox) => void,
): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const codes = selection.get(entry.key);
    if (!codes || codes.size === 0) continue;

    try {
      // Cached by loadParquetBatches — no refetch after the options load.
      const table = await loadParquetBatches(entry.source, () => {});
      const codeCol = table.getChild(entry.key);
      if (!codeCol) return;

      const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      let any = false;
      for (let row = 0; row < codeCol.length; row++) {
        const raw = codeCol.get(row);
        if (raw === null || raw === undefined || !codes.has(String(raw))) continue;
        if (extendRowBbox(table, row, bbox)) any = true;
      }
      if (any) {
        flyToBbox(bbox);
        onBbox?.(bbox);
      }
    } catch (err) {
      console.warn(`Filter fly-to failed for "${entry.name}":`, err);
    }
    return; // only the finest selected level counts
  }
}

/**
 * State for the Filter section: loads filter.json + the option tables,
 * cascades dropdown options coarse-to-fine, prunes orphaned selections, and
 * keeps the module-level area-filter store (read by rendering/picking) in sync.
 * With `flyTo` enabled (map.json `filterFlyTo`), every selection change flies
 * the maps to the selected areas. `onFlyToBbox` additionally receives the
 * framed bbox, for callers that must move a camera no mounted MapView owns.
 */
export function useAreaFilter(options?: {
  flyTo?: boolean;
  onFlyToBbox?: (bbox: BBox) => void;
}): AreaFilterState {
  const flyToEnabled = options?.flyTo ?? true;
  // Read at call time rather than captured, so a caller passing an inline
  // callback is always the one invoked. React needed a ref plus a render-time
  // write to achieve this without destabilising setValue's identity; nothing
  // here depends on callback identity, so the indirection is gone.
  function onFlyToBbox(bbox: BBox) {
    options?.onFlyToBbox?.(bbox);
  }

  const [entries, setEntries] = createSignal<AreaFilterEntry[]>([]);
  const [optionsByKey, setOptionsByKey] = createSignal<Map<string, AreaFilterOption[]>>(
    new Map(),
  );
  const [selections, setSelections] = createSignal<Map<string, Set<string>>>(new Map());

  onMount(() => {
    let cancelled = false;
    (async () => {
      const config = await loadAreaFilterConfig();
      if (cancelled) return;

      const loaded: AreaFilterEntry[] = [];
      const byKey = new Map<string, AreaFilterOption[]>();
      // The sources are the same URLs as the CBS layers in layers.json, so
      // loadParquetBatches' table cache means one download per session.
      await Promise.all(
        config.map(async (entry) => {
          try {
            const table = await loadParquetBatches(entry.source, () => {});
            const extracted = extractOptions(table, entry);
            if (extracted) {
              loaded.push(entry);
              byKey.set(entry.key, extracted);
            }
          } catch (err) {
            console.warn(`filter.json: failed to load options for "${entry.name}"`, err);
          }
        }),
      );
      if (cancelled) return;
      // Preserve filter.json order (= cascade order) regardless of load order.
      loaded.sort((a, b) => config.indexOf(a) - config.indexOf(b));
      setEntries(loaded);
      setOptionsByKey(byKey);
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  function optionsFor(
    entry: AreaFilterEntry,
    against: Map<string, Set<string>> = selections(),
  ): AreaFilterOption[] {
    const opts = optionsByKey().get(entry.key) ?? [];
    const list = entries();
    const index = list.indexOf(entry);
    // Narrow by the nearest coarser level with a non-empty selection.
    for (let i = index - 1; i >= 0; i--) {
      const ancestor = list[i];
      const selected = against.get(ancestor.key);
      if (!selected || selected.size === 0) continue;
      return opts.filter((o) => optionMatchesAncestor(o, ancestor.key, selected));
    }
    return opts;
  }

  function isEnabled(entry: AreaFilterEntry): boolean {
    return dependenciesSatisfied(entry, entries(), selections());
  }

  /** Push the new selection into the module store, which is itself a signal. */
  function commit(next: Map<string, Set<string>>) {
    // Drop selections whose dependencies are no longer met (keeps the map in
    // sync with the disabled dropdowns).
    pruneDisabledSelections(next, entries());
    setSelections(() => next);
    setAreaFilterSelection(next);
  }

  function setValue(key: string, code: string | null) {
    const list = entries();
    const next = new Map(selections());
    // Single-selection: replace the level with the chosen code (or clear it).
    next.set(key, code === null ? new Set() : new Set([code]));

    // Prune finer selections orphaned by the change: every selected code in
    // a finer level must still pass the same ancestor test its options use.
    const keyIndex = list.findIndex((e) => e.key === key);
    for (let i = keyIndex + 1; i < list.length; i++) {
      const finer = list[i];
      const finerSelected = next.get(finer.key);
      if (!finerSelected || finerSelected.size === 0) continue;

      let ancestor: AreaFilterEntry | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const candidate = next.get(list[j].key);
        if (candidate && candidate.size > 0) {
          ancestor = list[j];
          break;
        }
      }
      if (!ancestor) continue;

      const ancestorCodes = next.get(ancestor.key)!;
      const finerOptions = optionsByKey().get(finer.key) ?? [];
      const kept = new Set(
        [...finerSelected].filter((selectedCode) => {
          const option = finerOptions.find((o) => o.code === selectedCode);
          return option ? optionMatchesAncestor(option, ancestor!.key, ancestorCodes) : false;
        }),
      );
      next.set(finer.key, kept);
    }

    commit(next);
    if (flyToEnabled) {
      void flyToSelection(list, next, onFlyToBbox);
    }
  }

  function clearLevel(key: string) {
    const next = new Map(selections());
    next.set(key, new Set());
    // Finer selections that don't depend on this level stay valid within the
    // (now wider) unfiltered options; `commit` prunes any that do depend on it.
    commit(next);
  }

  function applySelections(next: Map<string, Set<string>>, opts?: { fly?: boolean }) {
    // commit() prunes IN PLACE, so `copy` is the post-prune truth by the time
    // flyToSelection reads it — same object, same ordering as setValue.
    const copy = new Map(next);
    commit(copy);
    if (opts?.fly && flyToEnabled) {
      void flyToSelection(entries(), copy, onFlyToBbox);
    }
  }

  return { entries, optionsFor, isEnabled, selections, setValue, clearLevel, applySelections };
}
