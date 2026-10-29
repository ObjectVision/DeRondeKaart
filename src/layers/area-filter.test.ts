import { afterEach, describe, expect, it } from "vitest";

import {
  areaFilterExpression,
  arrowRowMatchesAreaFilter,
  featureMatchesAreaFilter,
  isAreaFilterActive,
  setAreaFilterSelection,
} from "@/layers/area-filter";

/**
 * The gebiedsfilter holds a SET of codes per level, not one, so that the
 * landing page can select several gemeenten / wijken / buurten at once.
 *
 * The semantics these tests pin are stated in area-filter.ts: *AND across
 * levels, OR within a level*, levels whose column a layer lacks are skipped,
 * and a level falls back to a coarser CBS code column by digit prefix. The
 * multi-code cases are the ones that were never covered — this module had no
 * test file at all — and they are exactly what a multi-area selection relies
 * on, in all three consumers (tiles, charts, picking).
 */

/** Recursively collect every array literal nested in an expression. */
function arrays(expr: unknown): unknown[][] {
  if (!Array.isArray(expr)) return [];
  return [expr, ...expr.flatMap((child) => arrays(child))];
}

/** The `match` label list for a level's own key column. */
function matchLabels(expr: unknown, key: string): unknown[] | undefined {
  for (const node of arrays(expr)) {
    if (
      node[0] === "match" &&
      Array.isArray(node[1]) &&
      node[1][0] === "get" &&
      node[1][1] === key
    ) {
      return node[2] as unknown[];
    }
  }
  return undefined;
}

/** One arrow-ish record batch exposing the given columns. */
function batch(columns: Record<string, (string | null)[]>) {
  return {
    getChild: (name: string) =>
      name in columns ? { get: (i: number) => columns[name][i] } : null,
  };
}

afterEach(() => setAreaFilterSelection(new Map()));

describe("areaFilterExpression", () => {
  it("is null while nothing is selected", () => {
    expect(areaFilterExpression()).toBeNull();
    expect(isAreaFilterActive()).toBe(false);
  });

  it("lists every selected code of a level in one match", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983", "GM0984"])]]));

    // OR within a level: a single N-ary `match`, not one clause per code.
    expect(matchLabels(areaFilterExpression(), "gm_code")).toEqual([
      "GM0983",
      "GM0984",
    ]);
  });

  it("ANDs the levels together when several have a selection", () => {
    setAreaFilterSelection(
      new Map([
        ["gm_code", new Set(["GM0983"])],
        ["wk_code", new Set(["WK098301", "WK098302"])],
      ]),
    );

    const expr = areaFilterExpression();
    expect(expr?.[0]).toBe("all");
    expect(matchLabels(expr, "gm_code")).toEqual(["GM0983"]);
    expect(matchLabels(expr, "wk_code")).toEqual(["WK098301", "WK098302"]);
  });

  // A layer carrying only `bu_code` must still honour a gemeente selection,
  // which is what the digit-prefix fallback is for. With several codes selected
  // each one needs its own prefix test, or the layer would silently show only
  // the first gemeente's buurten.
  it("emits a digit-prefix fallback for each selected code", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983", "GM0984"])]]));

    const flat = JSON.stringify(areaFilterExpression());
    expect(flat).toContain('"0983"');
    expect(flat).toContain('"0984"');
  });
});

describe("arrowRowMatchesAreaFilter", () => {
  const rows = (columns: Record<string, (string | null)[]>, index: number) => ({
    index,
    data: { data: batch(columns) },
  });

  it("passes everything while nothing is selected", () => {
    expect(arrowRowMatchesAreaFilter(rows({ gm_code: ["GM0888"] }, 0))).toBe(true);
  });

  it("keeps a row matching any selected code of a level", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983", "GM0984"])]]));
    const columns = { gm_code: ["GM0983", "GM0984", "GM0888"] };

    expect(arrowRowMatchesAreaFilter(rows(columns, 0))).toBe(true);
    expect(arrowRowMatchesAreaFilter(rows(columns, 1))).toBe(true);
    expect(arrowRowMatchesAreaFilter(rows(columns, 2))).toBe(false);
  });

  // The hierarchy fallback, over several codes: a buurt belongs to the
  // selection when its code starts with any selected gemeente's digits.
  it("matches a finer column by digit prefix against every selected code", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983", "GM0984"])]]));
    const columns = { bu_code: ["BU09830001", "BU09840002", "BU08880003"] };

    expect(arrowRowMatchesAreaFilter(rows(columns, 0))).toBe(true);
    expect(arrowRowMatchesAreaFilter(rows(columns, 1))).toBe(true);
    expect(arrowRowMatchesAreaFilter(rows(columns, 2))).toBe(false);
  });

  it("skips a level the layer has no column for", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983"])]]));

    expect(arrowRowMatchesAreaFilter(rows({ other: ["x"] }, 0))).toBe(true);
  });
});

describe("featureMatchesAreaFilter", () => {
  it("keeps a feature matching any selected code", () => {
    setAreaFilterSelection(new Map([["gm_code", new Set(["GM0983", "GM0984"])]]));

    expect(featureMatchesAreaFilter({ gm_code: "GM0984" })).toBe(true);
    expect(featureMatchesAreaFilter({ gm_code: "GM0888" })).toBe(false);
  });

  it("ANDs across levels", () => {
    setAreaFilterSelection(
      new Map([
        ["gm_code", new Set(["GM0983", "GM0984"])],
        ["wk_code", new Set(["WK098301"])],
      ]),
    );

    expect(
      featureMatchesAreaFilter({ gm_code: "GM0983", wk_code: "WK098301" }),
    ).toBe(true);
    // Right gemeente, wrong wijk.
    expect(
      featureMatchesAreaFilter({ gm_code: "GM0983", wk_code: "WK098399" }),
    ).toBe(false);
  });

  it("drops empty levels from the selection entirely", () => {
    setAreaFilterSelection(
      new Map([
        ["gm_code", new Set(["GM0983"])],
        ["wk_code", new Set<string>()],
      ]),
    );

    // The empty wijk level must not reject features that carry no wk_code.
    expect(featureMatchesAreaFilter({ gm_code: "GM0983" })).toBe(true);
  });
});
