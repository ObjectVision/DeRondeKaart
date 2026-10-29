import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { buildNativeLayerDefs } from "@/layers/mvt-style";
import { clearLayerConfigCache, loadLayerConfigs } from "@/layers/config";
import type { LayerConfig } from "@/layers/types";

/**
 * The woonzorglimburg study area's styling, pinned at the level that actually
 * renders: the MapLibre layer defs the real `layers.json` produces, through the
 * real loader.
 *
 * It is worth pinning because two of the three fixes here are invisible in the
 * config on its own:
 *
 *  - `outlineWidth` is a NO-OP on a Fill symbolizer — `buildFillLayerDef` reads
 *    it only as a zero/non-zero test and emits `fill-outline-color`, which
 *    MapLibre locks to 1px. The borders are therefore hand-written `line`
 *    layers via the raw type/paint override, and a well-meaning "tidy-up" back
 *    to `outlineWidth: 2.5` would silently return them to 1px.
 *  - the mask has to stay DARK. A light one pushes the outside toward the same
 *    pale colour as the inside, so contrast drops instead of rising; that is
 *    the bug this styling fixes, and a light value reads as plausible in review.
 *
 * Both variants are asserted: they are maintained as identical, and a drift
 * between them would mean the public site and staging disagree visually.
 */

const VARIANTS = ["publiek", "ontwikkel"] as const;
const STUDY_AREA_ID = "studiegebied_limburg";
const NAVY = "#00498D";

/** Serve one variant's real layers.json to the loader. */
function stubVariant(variant: string) {
  const raw = JSON.parse(
    readFileSync(`configs/woonzorglimburg/${variant}/layers.json`, "utf8"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, statusText: "OK", json: async () => raw })),
  );
}

async function studyArea(variant: string): Promise<LayerConfig> {
  stubVariant(variant);
  const config = (await loadLayerConfigs()).find((c) => c.id === STUDY_AREA_ID);
  if (!config) throw new Error(`${variant}: no layer "${STUDY_AREA_ID}"`);
  return config;
}

beforeEach(() => clearLayerConfigCache());

afterEach(() => {
  clearLayerConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(VARIANTS)("study area styling (%s)", (variant) => {
  const defs = async () => buildNativeLayerDefs(await studyArea(variant));
  const byRule = async (name: string) =>
    (await defs()).find((d) => d.ruleName === name);

  it("keeps the layer out of the legend, picking and comparison", async () => {
    const config = await studyArea(variant);

    // Its rule names are only MapLibre layer ids, which is what makes adding
    // the border rules safe — they are not legend rows or share-link classes.
    expect(config.excludeFromLegend).toBe(true);
    expect(config.excludeFromPicking).toBe(true);
    expect(config.excludeFromComparison).toBe(true);
    expect(config.beforeid).toBe("studyarea-layers");
  });

  it("masks the outside with a DARK fill, not a light one", async () => {
    const outer = await byRule("outer");

    expect(outer?.type).toBe("fill");
    expect(outer?.paint["fill-color"]).toBe("#183A59");
    expect(outer?.paint["fill-opacity"]).toBe(0.35);
    // Only the area outside the study area (`id` 1) is dimmed.
    expect(outer?.filter).toEqual(["==", ["get", "id"], 1]);
  });

  it("leaves the analysed sub-regions clear, so data shows through", async () => {
    for (const name of ["Noord-Limburg", "Roermond", "Zuid-Limburg"]) {
      const def = await byRule(name);
      expect(def?.type).toBe("fill");
      expect(def?.paint["fill-color"]).toBe("#00000000");
      // The stray 1px edge is suppressed; the border rules draw it instead.
      expect(def?.paint["fill-outline-color"]).toBe("transparent");
      expect(def?.paint["fill-pattern"]).toBeUndefined();
    }
  });

  it("hatches Midden-Limburg, which is not part of the analysis", async () => {
    const def = await byRule("Midden-Limburg");

    expect(def?.type).toBe("fill");
    expect(def?.paint["fill-pattern"]).toBe(`hatch-${NAVY}-#ffffff-1`);
    // fill-color survives alongside the pattern on purpose: a sprite that
    // fails to register degrades to a solid fill rather than nothing.
    expect(def?.paint["fill-color"]).toBe("#ffffff");
  });

  // The whole point of the raw override: a Fill's outlineWidth cannot do this.
  it("draws every border as a real line of the full width", async () => {
    for (const [name, id] of [
      ["Noord-Limburg grens", 2],
      ["Roermond grens", 3],
      ["Midden-Limburg grens", 4],
      ["Zuid-Limburg grens", 5],
    ] as const) {
      const def = await byRule(name);
      expect(def?.type).toBe("line");
      expect(def?.paint["line-color"]).toBe(NAVY);
      expect(def?.paint["line-width"]).toBe(2.5);
      expect(def?.filter).toEqual(["==", ["get", "id"], id]);
    }
  });

  // Rules become layers in array order and the last one wins, so a border
  // placed before a fill would be painted over by it.
  it("orders every border after every fill", async () => {
    const names = (await defs()).map((d) => d.ruleName ?? "");
    const lastFill = Math.max(
      ...names.map((n, i) => (n.endsWith(" grens") ? -1 : i)),
    );
    const firstBorder = names.findIndex((n) => n.endsWith(" grens"));

    expect(firstBorder).toBeGreaterThan(lastFill);
  });

  it("gives every rule its own layer id", async () => {
    const ids = (await defs()).map((d) => d.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

it("styles both variants identically", async () => {
  const rendered: string[] = [];
  for (const variant of VARIANTS) {
    rendered.push(JSON.stringify(buildNativeLayerDefs(await studyArea(variant))));
    clearLayerConfigCache();
  }

  expect(rendered[0]).toBe(rendered[1]);
});
