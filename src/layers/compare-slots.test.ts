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
import { buildNativeLayerDefs, isHighlightLayerId } from "@/layers/mvt-style";
import type { LayerConfig } from "@/layers/types";

function area(n: number) {
  return { featureId: n, layerId: "buurt_klik", code: `BU000${n}`, label: `Buurt ${n}` };
}

beforeEach(() => {
  clearCompareSelections();
});

describe("compare slots", () => {
  it("numbers selections by position, oldest first", () => {
    toggleCompareSelection(area(1));
    toggleCompareSelection(area(2));
    expect(compareSelections().map((s) => s.slot)).toEqual([0, 1]);

    // Removing the first moves the second a colour down rather than leaving a hole.
    removeCompareSelection(0);
    expect(compareSelections().map((s) => [s.code, s.slot])).toEqual([["BU0002", 0]]);

    toggleCompareSelection(area(3));
    expect(compareSelections().map((s) => [s.code, s.slot])).toEqual([
      ["BU0002", 0],
      ["BU0003", 1],
    ]);
  });

  it("toggles an already-selected area off", () => {
    toggleCompareSelection(area(1));
    expect(toggleCompareSelection(area(1))).toHaveLength(0);
    expect(compareSelections()).toHaveLength(0);
  });

  it("rolls the oldest out when a fifth area is clicked", () => {
    for (let n = 1; n <= MAX_COMPARE_SLOTS; n++) toggleCompareSelection(area(n));
    expect(compareSelections().map((s) => [s.code, s.slot])).toEqual([
      ["BU0001", 0],
      ["BU0002", 1],
      ["BU0003", 2],
      ["BU0004", 3],
    ]);

    toggleCompareSelection(area(5));

    // The first is gone, the rest each moved one colour down, and the newcomer
    // took the last colour.
    expect(compareSelections()).toHaveLength(MAX_COMPARE_SLOTS);
    expect(compareSelections().map((s) => [s.code, s.slot])).toEqual([
      ["BU0002", 0],
      ["BU0003", 1],
      ["BU0004", 2],
      ["BU0005", 3],
    ]);
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

describe("compare outline layers", () => {
  it("are built for a selectable layer and survive the dim tool", () => {
    const config = {
      id: "selectie_gemeente",
      name: "Selectie",
      source: "https://example.test/selectie.pmtiles",
      format: "pmtiles",
      sourceLayer: "gemeente",
      geometryType: "polygon",
      style: { color: [0, 0, 0, 255], opacity: 0 },
      highlightable: true,
      compareSelectable: true,
      idProperty: "gm_code",
    } as unknown as LayerConfig;

    const ids = buildNativeLayerDefs(config).map((def) => def.id);
    expect(ids).toContain("pmtiles-layer-selectie_gemeente-compare");
    expect(ids).toContain("pmtiles-layer-selectie_gemeente-compare-casing");
    // The dim tool must skip them, or fading a layer would fade the selection
    // drawn on top of it.
    expect(isHighlightLayerId("pmtiles-layer-selectie_gemeente-compare")).toBe(true);
    expect(isHighlightLayerId("pmtiles-layer-selectie_gemeente-compare-casing")).toBe(true);
  });

  it("are absent when the layer did not opt in", () => {
    const config = {
      id: "gewoon",
      name: "Gewoon",
      source: "https://example.test/x.pmtiles",
      format: "pmtiles",
      sourceLayer: "x",
      geometryType: "polygon",
      style: {},
      highlightable: true,
    } as unknown as LayerConfig;

    const ids = buildNativeLayerDefs(config).map((def) => def.id);
    expect(ids.some((id) => id.includes("-compare"))).toBe(false);
  });
});
