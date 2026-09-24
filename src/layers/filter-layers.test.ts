import { beforeEach, describe, expect, it } from "vitest";

import {
  addFilterLayer,
  getFilterLayerById,
  getFilterLayerVersion,
  getFilterLayers,
  removeFilterLayer,
  updateFilterLayer,
} from "@/layers/filter-layers";

const REFS = [{ layerId: "a", ruleName: "goed" }];

beforeEach(() => {
  for (const def of getFilterLayers()) removeFilterLayer(def.id);
});

describe("updateFilterLayer", () => {
  it("replaces the definition in place, keeping id and store position", () => {
    const { def: first } = addFilterLayer("Eerste", REFS);
    const { def: second } = addFilterLayer("Tweede", REFS);

    const refs = [...REFS, { layerId: "b", ruleName: "hoog" }];
    const classes = [
      { label: "een", color: "#000000" },
      { label: "twee", color: "#ffffff" },
    ];
    const updated = updateFilterLayer(first.id, { name: "Aangepast", refs, classes });

    expect(updated).toEqual({ id: first.id, name: "Aangepast", refs, classes });
    expect(getFilterLayerById(first.id)).toEqual(updated);
    expect(getFilterLayers().map((def) => def.id)).toEqual([first.id, second.id]);
  });

  it("bumps the store version", () => {
    const { def } = addFilterLayer("Eerste", REFS);
    const before = getFilterLayerVersion();
    updateFilterLayer(def.id, { name: "x", refs: REFS, classes: def.classes });
    expect(getFilterLayerVersion()).toBe(before + 1);
  });

  it("drops the steps when the edit leaves none, rather than keeping stale years", () => {
    const { def } = addFilterLayer("Eerste", REFS, undefined, { a: 2040 });
    const updated = updateFilterLayer(def.id, {
      name: "x",
      refs: REFS,
      classes: def.classes,
      steps: {},
    });
    expect(updated).not.toHaveProperty("steps");
  });

  it("returns undefined and leaves the store alone for an unknown id", () => {
    addFilterLayer("Eerste", REFS);
    const before = getFilterLayerVersion();
    expect(updateFilterLayer("filter__999", { name: "x", refs: REFS, classes: [] })).toBeUndefined();
    expect(getFilterLayerVersion()).toBe(before);
  });
});
