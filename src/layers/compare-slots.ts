/**
 * The dashboard's area comparison: up to four map features held side by side,
 * each in its own colour.
 *
 * A module store rather than component state, mirroring `area-filter.ts`: the
 * click handler, the outline layers and the comparison panel all need it, and
 * they sit in three different parts of the tree. Setters build a fresh array so
 * identity changes exactly when the content does.
 */
import { createSignal } from "solid-js";

import type { LayerConfig } from "./types";

/**
 * How many areas can be compared at once.
 *
 * Four because the panel puts them side by side and a fifth column stops being
 * readable — and because the outline colours have to stay tellable apart.
 */
export const MAX_COMPARE_SLOTS = 4;

/**
 * Slot colours, in assignment order. A qualitative palette (ColorBrewer Set1),
 * so the four selections read as different rather than as a scale — none of
 * them means "more" than another.
 */
export const COMPARE_SLOT_COLORS = ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3"];

/** No slot: what an unselected feature's state holds. */
export const NO_COMPARE_SLOT = -1;

export interface CompareSelection {
  /** Slot index, 0-based; indexes {@link COMPARE_SLOT_COLORS}. */
  slot: number;
  /** The feature's stable id, as promoted onto the tiles. */
  featureId: string | number;
  /** Layer the feature was clicked in — needed to address its feature state. */
  layerId: string;
  /** CBS code the comparison queries on, e.g. `"BU08820000"`. */
  code: string;
  /** What the panel calls this area. */
  label: string;
}

const [compareSelections, setCompareSelections] = createSignal<CompareSelection[]>([]);

export { compareSelections };

/** Colour of a slot, wrapping rather than going undefined on a bad index. */
export function compareSlotColor(slot: number): string {
  return COMPARE_SLOT_COLORS[slot % COMPARE_SLOT_COLORS.length];
}

/** Whether a layer's features may be added to the comparison. */
export function isCompareSelectable(config: LayerConfig): boolean {
  return Boolean(config.compareSelectable && config.highlightable);
}

/** The lowest slot number nobody holds, or -1 when all four are taken. */
function freeSlot(current: CompareSelection[]): number {
  for (let slot = 0; slot < MAX_COMPARE_SLOTS; slot++) {
    if (!current.some((selection) => selection.slot === slot)) return slot;
  }
  return NO_COMPARE_SLOT;
}

export interface ToggleResult {
  /** What the store now holds. */
  selections: CompareSelection[];
  /** True when the click was refused because every slot was taken. */
  full: boolean;
}

/**
 * Add a feature to the comparison, or drop it when it is already in.
 *
 * A fifth selection is refused rather than evicting the oldest: the user picked
 * those four, and silently replacing one of them loses work they cannot see was
 * lost. The caller reports the refusal.
 */
export function toggleCompareSelection(
  entry: Omit<CompareSelection, "slot">,
): ToggleResult {
  const current = compareSelections();
  const existing = current.find(
    (selection) => selection.layerId === entry.layerId && selection.featureId === entry.featureId,
  );
  if (existing) {
    const next = current.filter((selection) => selection !== existing);
    setCompareSelections(next);
    return { selections: next, full: false };
  }

  const slot = freeSlot(current);
  if (slot === NO_COMPARE_SLOT) return { selections: current, full: true };

  const next = [...current, { ...entry, slot }];
  setCompareSelections(next);
  return { selections: next, full: false };
}

/** Drop one selection by slot. */
export function removeCompareSelection(slot: number): CompareSelection[] {
  const next = compareSelections().filter((selection) => selection.slot !== slot);
  setCompareSelections(next);
  return next;
}

/** Drop them all — closing the comparison, or a config change that invalidates it. */
export function clearCompareSelections(): CompareSelection[] {
  const cleared = compareSelections();
  setCompareSelections([]);
  return cleared;
}
