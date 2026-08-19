import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_COMPARE_SLOTS,
  clearCompareSelections,
  compareSelections,
  compareSlotColor,
  isCompareSelectable,
  removeCompareSelection,
  toggleCompareSelection,
} from "@/layers/compare-slots";
import type { LayerConfig } from "@/layers/types";

function area(n: number) {
  return { featureId: n, layerId: "buurt_klik", code: `BU000${n}`, label: `Buurt ${n}` };
}

beforeEach(() => {
  clearCompareSelections();
});

describe("compare slots", () => {
  it("assigns slots in order and reuses a freed one", () => {
    toggleCompareSelection(area(1));
    toggleCompareSelection(area(2));
    expect(compareSelections().map((s) => s.slot)).toEqual([0, 1]);

    // Freeing slot 0 must hand it to the next area rather than growing to 2.
    removeCompareSelection(0);
    toggleCompareSelection(area(3));
    expect(compareSelections().map((s) => s.slot).sort()).toEqual([0, 1]);
  });

  it("toggles an already-selected area off", () => {
    toggleCompareSelection(area(1));
    const result = toggleCompareSelection(area(1));
    expect(result.full).toBe(false);
    expect(compareSelections()).toHaveLength(0);
  });

  it("refuses a fifth area instead of evicting one", () => {
    for (let n = 1; n <= MAX_COMPARE_SLOTS; n++) toggleCompareSelection(area(n));
    const result = toggleCompareSelection(area(99));
    expect(result.full).toBe(true);
    expect(compareSelections()).toHaveLength(MAX_COMPARE_SLOTS);
    expect(compareSelections().some((s) => s.code === "BU0099")).toBe(false);
  });

  it("gives every slot its own colour", () => {
    const colors = new Set(
      Array.from({ length: MAX_COMPARE_SLOTS }, (_, slot) => compareSlotColor(slot)),
    );
    expect(colors.size).toBe(MAX_COMPARE_SLOTS);
  });

  it("only offers layers that opted in and can carry feature ids", () => {
    const base = { id: "x", name: "X", source: "", format: "pmtiles" } as LayerConfig;
    expect(isCompareSelectable({ ...base, compareSelectable: true, highlightable: true })).toBe(
      true,
    );
    // Without highlightable there is no promoteId, so feature state cannot be
    // addressed and the outline would silently never appear.
    expect(isCompareSelectable({ ...base, compareSelectable: true })).toBe(false);
    expect(isCompareSelectable({ ...base, highlightable: true })).toBe(false);
  });
});
