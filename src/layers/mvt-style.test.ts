import { describe, expect, it } from "vitest";

import { chromeIconColor } from "@/config/map-config";
import {
  COMPARE_CASING_RULE,
  COMPARE_RULE,
  HIGHLIGHT_CASING_RULE,
  HIGHLIGHT_RULE,
  SELECTABLE_RULE,
  buildNativeLayerDefs,
  isHighlightLayerId,
} from "@/layers/mvt-style";
import type { LayerConfig } from "@/layers/types";

/**
 * The selection layer: one archive holding three levels at every zoom.
 * Filters run at the tile zoom, so "< 11" is zooms 0-10 and "< 13" is 11-12.
 */
const ZOOM_FILTER = [
  "case",
  ["<", ["zoom"], 11],
  ["==", ["slice", ["get", "statcode"], 0, 2], "GM"],
  ["<", ["zoom"], 13],
  ["==", ["slice", ["get", "statcode"], 0, 2], "WK"],
  ["==", ["slice", ["get", "statcode"], 0, 2], "BU"],
];

function selectionConfig(): LayerConfig {
  return {
    id: "selectie",
    name: "Gebiedsselectie",
    source: "https://example.test/selectie.pmtiles",
    format: "pmtiles",
    sourceLayer: "selectie",
    geometryType: "polygon",
    style: { color: [0, 0, 0, 255], opacity: 0 },
    highlightable: true,
    highlightcasing: true,
    compareSelectable: true,
    idProperty: "statcode",
    geostyler: {
      name: "selectie",
      rules: [
        {
          name: "Gebied",
          type: "fill",
          paint: { "fill-color": "#000000", "fill-opacity": 0 },
          rawFilter: ZOOM_FILTER,
        },
      ],
    },
  } as unknown as LayerConfig;
}

describe("rawFilter", () => {
  it("becomes the data layer's filter verbatim", () => {
    const defs = buildNativeLayerDefs(selectionConfig());
    const data = defs.find((def) => def.ruleName === "Gebied");
    expect(data?.filter).toEqual(ZOOM_FILTER);
  });

  /**
   * The point of the whole arrangement: the data layer shows one level per
   * zoom, but the outlines are unfiltered, so a feature selected at one level
   * keeps its outline after zooming into another level's range — the geometry
   * is in every tile, and nothing filters it away.
   */
  it("is not applied to the highlight and comparison outlines", () => {
    const defs = buildNativeLayerDefs(selectionConfig());
    const outlines = defs.filter((def) => isHighlightLayerId(def.id));
    expect(outlines).toHaveLength(4); // highlight + casing, compare + casing
    for (const outline of outlines) {
      expect(outline.filter).toBeUndefined();
    }
  });
});

describe("selectable outline", () => {
  const selectableDef = () =>
    buildNativeLayerDefs(selectionConfig()).find((def) => def.id.endsWith(`-${SELECTABLE_RULE}`));

  it("draws a thin line in the chrome accent", () => {
    const def = selectableDef();
    expect(def?.type).toBe("line");
    expect(def?.paint["line-color"]).toBe(chromeIconColor());
    expect(def?.paint["line-width"]).toBe(1);
  });

  /** Unlike the selection outlines, this one marks what is clickable *now*. */
  it("carries the data layer's zoom filter", () => {
    expect(selectableDef()?.filter).toEqual(ZOOM_FILTER);
  });

  it("draws under the highlight and comparison outlines", () => {
    const defs = buildNativeLayerDefs(selectionConfig());
    const selectable = defs.findIndex((def) => def.id.endsWith(`-${SELECTABLE_RULE}`));
    const firstOutline = defs.findIndex((def) => isHighlightLayerId(def.id));
    expect(selectable).toBeLessThan(firstOutline);
  });

  /**
   * A layer that styles its own boundaries has said how it wants to be drawn,
   * and the generated grid would only fight it — `selectie` draws red
   * gemeentegrenzen at every zoom over the wijk/buurt levels, which no single
   * generated outline expresses.
   */
  it("is left off a layer whose own style draws lines", () => {
    // Same escape hatch the fixture itself uses: a hand-written rule carries
    // `type` + `paint` instead of a symbolizer, which the config types describe
    // through RawStyleOverrides rather than the rule shape.
    const config = selectionConfig();
    const rules = (config as unknown as { geostyler: { rules: unknown[] } }).geostyler.rules;
    rules.push({
      name: "Gemeentegrens",
      type: "line",
      paint: { "line-color": "#FF0000", "line-width": 1 },
      rawFilter: ["==", ["slice", ["get", "statcode"], 0, 2], "GM"],
    });

    const defs = buildNativeLayerDefs(config);
    expect(defs.some((def) => def.id.endsWith(`-${SELECTABLE_RULE}`))).toBe(false);
    // The layer's own rule is what replaces it, so it has to survive.
    expect(defs.find((def) => def.ruleName === "Gemeentegrens")?.type).toBe("line");
  });

  it("is left off a layer that cannot be compared", () => {
    const config = { ...selectionConfig(), compareSelectable: false } as LayerConfig;
    const defs = buildNativeLayerDefs(config);
    expect(defs.some((def) => def.id.endsWith(`-${SELECTABLE_RULE}`))).toBe(false);
  });
});

describe("comparison outline", () => {
  const defs = () => buildNativeLayerDefs(selectionConfig());
  const bySuffix = (suffix: string) =>
    defs().find((def) => def.id.endsWith(`-${suffix}`));

  /**
   * `onOff` builds ["case", …conditions, on, off]; the "on" value sits at index
   * 2 in both the compare and the highlight variants, so the widths can be
   * compared without restating the numbers here.
   */
  const onWidth = (suffix: string) =>
    (bySuffix(suffix)?.paint["line-width"] as unknown[])[2];

  it("draws solid, not dashed", () => {
    expect(bySuffix(COMPARE_RULE)?.paint).not.toHaveProperty("line-dasharray");
  });

  /**
   * Asserted against the highlight defs rather than literals: the point is that
   * a selected area and a clicked one are the same shape, so retuning
   * HIGHLIGHT_WIDTH must move both or fail here.
   */
  it("takes the pick highlight's width and casing", () => {
    expect(onWidth(COMPARE_RULE)).toBe(onWidth(HIGHLIGHT_RULE));
    expect(onWidth(COMPARE_CASING_RULE)).toBe(onWidth(HIGHLIGHT_CASING_RULE));
  });

  /**
   * Sharing that geometry is what makes the order load-bearing: hovering an
   * already-selected area has to show the hover, so the highlight draws last.
   */
  it("draws under the hover highlight", () => {
    const ids = defs().map((def) => def.id);
    const index = (suffix: string) => ids.findIndex((id) => id.endsWith(`-${suffix}`));
    expect(index(COMPARE_CASING_RULE)).toBeLessThan(index(HIGHLIGHT_CASING_RULE));
    expect(index(COMPARE_RULE)).toBeLessThan(index(HIGHLIGHT_RULE));
  });

  it("colours each slot from feature state", () => {
    const color = bySuffix(COMPARE_RULE)?.paint["line-color"] as unknown[];
    expect(color[0]).toBe("match");
    expect(color).toContain("#e41a1c");
  });
});
