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

/**
 * Number the selections by their place in the list: oldest holds slot 0.
 *
 * The slot is a position rather than a claim, which is what makes the rollover
 * below work — dropping the oldest shifts everyone one colour down instead of
 * leaving a hole for the newcomer to fill.
 */
function withSlots(selections: Omit<CompareSelection, "slot">[]): CompareSelection[] {
  return selections.map((selection, index) => ({ ...selection, slot: index }));
}

/**
 * Add a feature to the comparison, or drop it when it is already in.
 *
 * Selecting a fifth area rolls the oldest out: it leaves the comparison, the
 * remaining three each move one colour down, and the new area takes the last
 * colour. So the four on screen are always the four most recently clicked, and
 * the colours always run in selection order.
 *
 * Returns what the store now holds.
 */
export function toggleCompareSelection(
  entry: Omit<CompareSelection, "slot">,
): CompareSelection[] {
  const current = compareSelections();
  const existing = current.find(
    (selection) => selection.layerId === entry.layerId && selection.featureId === entry.featureId,
  );

  const kept = existing
    ? current.filter((selection) => selection !== existing)
    : [...current, entry].slice(-MAX_COMPARE_SLOTS);

  const next = withSlots(kept);
  setCompareSelections(next);
  return next;
}

/** Drop one selection by slot; the ones after it move a colour down. */
export function removeCompareSelection(slot: number): CompareSelection[] {
  const next = withSlots(compareSelections().filter((selection) => selection.slot !== slot));
  setCompareSelections(next);
  return next;
}

/** Drop them all — closing the comparison, or a config change that invalidates it. */
export function clearCompareSelections(): CompareSelection[] {
  const cleared = compareSelections();
  setCompareSelections([]);
  return cleared;
}
