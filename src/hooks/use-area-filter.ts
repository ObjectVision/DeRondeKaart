import { useCallback, useEffect, useMemo, useState } from "react";
import { loadGeoParquetBatches } from "@/layers";
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
  entries: AreaFilterEntry[];
  /** Options for a dropdown, narrowed by coarser selections (cascade). */
  optionsFor(entry: AreaFilterEntry): AreaFilterOption[];
  /** Selected codes per key field. */
  selections: Map<string, Set<string>>;
  toggleValue(key: string, code: string): void;
  clearLevel(key: string): void;
  /** Mirrors the module store version; bumps on every selection change. */
  version: number;
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
 */
async function flyToSelection(
  entries: AreaFilterEntry[],
  selection: Map<string, Set<string>>,
): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const codes = selection.get(entry.key);
    if (!codes || codes.size === 0) continue;

    try {
      // Cached by loadGeoParquetBatches — no refetch after the options load.
      const table = await loadGeoParquetBatches(entry.source, () => {});
      const codeCol = table.getChild(entry.key);
      if (!codeCol) return;

      const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      let any = false;
      for (let row = 0; row < codeCol.length; row++) {
        const raw = codeCol.get(row);
        if (raw === null || raw === undefined || !codes.has(String(raw))) continue;
        if (extendRowBbox(table, row, bbox)) any = true;
      }
      if (any) flyToBbox(bbox);
    } catch (err) {
      console.warn(`Filter fly-to failed for "${entry.name}":`, err);
    }
    return; // only the finest selected level counts
  }
}

/**
 * React state for the Filter section: loads filter.json + the option tables,
 * cascades dropdown options coarse-to-fine, prunes orphaned selections, and
 * keeps the module-level area-filter store (read by rendering/picking) in sync.
 * With `flyTo` enabled (map.json `filterFlyTo`), every selection change flies
 * the maps to the selected areas.
 */
export function useAreaFilter(options?: { flyTo?: boolean }): AreaFilterState {
  const flyToEnabled = options?.flyTo ?? true;
  const [entries, setEntries] = useState<AreaFilterEntry[]>([]);
  const [optionsByKey, setOptionsByKey] = useState<Map<string, AreaFilterOption[]>>(
    new Map(),
  );
  const [selections, setSelections] = useState<Map<string, Set<string>>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const config = await loadAreaFilterConfig();
      if (cancelled) return;

      const loaded: AreaFilterEntry[] = [];
      const options = new Map<string, AreaFilterOption[]>();
      // The sources are the same URLs as the CBS layers in layers.json, so
      // loadGeoParquetBatches' table cache means one download per session.
      await Promise.all(
        config.map(async (entry) => {
          try {
            const table = await loadGeoParquetBatches(entry.source, () => {});
            const extracted = extractOptions(table, entry);
            if (extracted) {
              loaded.push(entry);
              options.set(entry.key, extracted);
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
      setOptionsByKey(options);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const optionsFor = useCallback(
    (entry: AreaFilterEntry): AreaFilterOption[] => {
      const options = optionsByKey.get(entry.key) ?? [];
      const index = entries.indexOf(entry);
      // Narrow by the nearest coarser level with a non-empty selection.
      for (let i = index - 1; i >= 0; i--) {
        const ancestor = entries[i];
        const selected = selections.get(ancestor.key);
        if (!selected || selected.size === 0) continue;
        return options.filter((o) => optionMatchesAncestor(o, ancestor.key, selected));
      }
      return options;
    },
    [entries, optionsByKey, selections],
  );

  /** Push the new selection into the module store and mirror its version. */
  const commit = useCallback((next: Map<string, Set<string>>) => {
    setSelections(next);
    setVersion(setAreaFilterSelection(next));
  }, []);

  const toggleValue = useCallback(
    (key: string, code: string) => {
      const next = new Map(selections);
      const codes = new Set(next.get(key) ?? []);
      if (codes.has(code)) {
        codes.delete(code);
      } else {
        codes.add(code);
      }
      next.set(key, codes);

      // Prune finer selections orphaned by the change: every selected code in
      // a finer level must still pass the same ancestor test its options use.
      const keyIndex = entries.findIndex((e) => e.key === key);
      for (let i = keyIndex + 1; i < entries.length; i++) {
        const finer = entries[i];
        const finerSelected = next.get(finer.key);
        if (!finerSelected || finerSelected.size === 0) continue;

        let ancestor: AreaFilterEntry | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const candidate = next.get(entries[j].key);
          if (candidate && candidate.size > 0) {
            ancestor = entries[j];
            break;
          }
        }
        if (!ancestor) continue;

        const ancestorCodes = next.get(ancestor.key)!;
        const finerOptions = optionsByKey.get(finer.key) ?? [];
        const kept = new Set(
          [...finerSelected].filter((selectedCode) => {
            const option = finerOptions.find((o) => o.code === selectedCode);
            return option
              ? optionMatchesAncestor(option, ancestor!.key, ancestorCodes)
              : false;
          }),
        );
        next.set(finer.key, kept);
      }

      commit(next);
      if (flyToEnabled) void flyToSelection(entries, next);
    },
    [selections, entries, optionsByKey, commit, flyToEnabled],
  );

  const clearLevel = useCallback(
    (key: string) => {
      const next = new Map(selections);
      next.set(key, new Set());
      // Finer selections stay: they were chosen from a narrower option set and
      // remain valid within the (now wider) unfiltered options.
      commit(next);
    },
    [selections, commit],
  );

  // Stable identity so React.memo consumers (Sidebar) don't re-render on
  // unrelated App renders.
  return useMemo(
    () => ({ entries, optionsFor, selections, toggleValue, clearLevel, version }),
    [entries, optionsFor, selections, toggleValue, clearLevel, version],
  );
}
