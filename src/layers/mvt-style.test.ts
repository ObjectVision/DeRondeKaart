import { describe, expect, it } from "vitest";

import { buildNativeLayerDefs, isHighlightLayerId } from "@/layers/mvt-style";
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
    const data = defs.find((def) => !isHighlightLayerId(def.id));
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
