import { describe, expect, it } from "vitest";

import { describeCombination } from "@/layers/combination-meta";
import {
  COMBINATION_STRATEGY,
  addFilterLayer,
  getFilterLayers,
  removeFilterLayer,
  type FilterLayerDef,
} from "@/layers/filter-layers";
import type { LayerConfig } from "@/layers/types";

function layer(id: string, name: string, ruleNames: string[], subname?: string): LayerConfig {
  return {
    id,
    name,
    subname,
    source: `https://example.test/${id}.fgb`,
    format: "flatgeobuf",
    geostyler: {
      name,
      rules: ruleNames.map((ruleName) => ({
        name: ruleName,
        symbolizers: [{ kind: "Fill", color: `#${ruleName.length}00000` }],
      })),
    },
  } as LayerConfig;
}

const CONFIGS = [
  layer("supermarkt", "Supermarkt", ["< 500 m", "500-1000 m", "> 1000 m"]),
  layer("groen", "3-30-300", ["goed", "zeer goed"], "Groennorm"),
];

const DEF: FilterLayerDef = {
  id: "filter__1",
  name: "Supermarkt < 500 m + 3-30-300 goed / zeer goed",
  refs: [
    { layerId: "supermarkt", ruleName: "< 500 m" },
    { layerId: "groen", ruleName: "goed" },
    { layerId: "groen", ruleName: "zeer goed" },
  ],
  classes: [
    { label: "1 van 2 criteria", color: "#d53e4f" },
    { label: "2 van 2 criteria", color: "#3288bd" },
  ],
  steps: { groen: 2030 },
};

describe("describeCombination", () => {
  it("lists one criterion per layer, classes grouped, in first-chosen order", () => {
    const info = describeCombination(DEF, CONFIGS);
    expect(info.criteria.map((c) => c.layerId)).toEqual(["supermarkt", "groen"]);
    expect(info.criteria[1].classes.map((c) => c.name)).toEqual(["goed", "zeer goed"]);
  });

  it("carries the layer's name, subname and frozen year", () => {
    const [supermarkt, groen] = describeCombination(DEF, CONFIGS).criteria;
    expect(supermarkt).toMatchObject({ name: "Supermarkt", year: undefined, missing: false });
    expect(groen).toMatchObject({ name: "3-30-300", subname: "Groennorm", year: 2030 });
  });

  it("attaches each class's source rule, for the legend swatch", () => {
    const [supermarkt] = describeCombination(DEF, CONFIGS).criteria;
    expect(supermarkt.classes[0].rule?.name).toBe("< 500 m");
  });

  it("still lists a layer missing from this variant, by id", () => {
    const info = describeCombination(DEF, [CONFIGS[1]]);
    expect(info.criteria[0]).toMatchObject({
      layerId: "supermarkt",
      name: "supermarkt",
      missing: true,
    });
    expect(info.criteria[0].classes[0]).toEqual({ name: "< 500 m", rule: undefined });
  });

  it("reports the name, strategy and legend in score order", () => {
    const info = describeCombination(DEF, CONFIGS);
    expect(info.name).toBe(DEF.name);
    expect(info.strategy).toBe(COMBINATION_STRATEGY);
    expect(info.legend.map((c) => c.label)).toEqual(["1 van 2 criteria", "2 van 2 criteria"]);
  });
});

describe("describeCombination with a combination as criterion", () => {
  it("names the source's classes by score, under their current labels", () => {
    for (const def of getFilterLayers()) removeFilterLayer(def.id);
    const { def: source } = addFilterLayer("Voorzieningen", [{ layerId: "supermarkt", ruleName: "< 500 m" }], [
      { label: "Eén", color: "#d53e4f" },
      { label: "Allebei", color: "#3288bd" },
    ]);
    const nested: FilterLayerDef = {
      id: "filter__99",
      name: "Afgeleid",
      // Chosen when score 2 was still labelled "2 van 2 criteria".
      refs: [{ layerId: source.id, ruleName: "2 van 2 criteria", score: 2 }],
      classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
    };

    const [criterion] = describeCombination(nested, CONFIGS).criteria;

    expect(criterion).toMatchObject({ name: "Voorzieningen", combination: true, missing: false });
    expect(criterion.classes.map((c) => c.name)).toEqual(["Allebei"]);
  });
});
