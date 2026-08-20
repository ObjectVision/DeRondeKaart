import { describe, expect, it, vi } from "vitest";

import { buildQuery } from "@/dashboard/query-builder";
import { buildSemanticModel } from "@/dashboard/semantic-model";

/** Two area tables joined on gm_code, plus a detached third. */
function model(extra: Record<string, unknown> = {}) {
  return buildSemanticModel({
    tables: [
      {
        name: "buurt",
        url: "https://example.test/buurt.parquet",
        key: "bu_code",
        columns: [{ name: "inwoners", role: "measure", label: "Inwoners" }],
      },
      {
        name: "gemeente",
        url: "https://example.test/gemeente.parquet",
        key: "gm_code",
        columns: [{ name: "gm_naam", role: "dimension", label: "Gemeente" }],
      },
      {
        name: "los",
        url: "https://example.test/los.parquet",
        key: "id",
        columns: [],
      },
    ],
    relationships: [{ from: "buurt.gm_code", to: "gemeente.gm_code" }],
    measures: [
      {
        id: "inwoners",
        table: "buurt",
        expression: "inwoners",
        aggregation: "sum",
        label: "Inwoners",
        format: "number",
      },
      {
        id: "los_meting",
        table: "los",
        expression: "waarde",
        aggregation: "mean",
        label: "Losse meting",
        format: "number",
      },
    ],
    dimensions: [
      { id: "gemeente_naam", table: "gemeente", column: "gm_naam", label: "Gemeente" },
    ],
    ...extra,
  });
}

describe("buildQuery", () => {
  it("aggregates a single measure without a dimension", () => {
    const plan = buildQuery(model(), { measures: ["inwoners"] });
    expect(plan?.sql).toBe('SELECT SUM(inwoners) AS "inwoners" FROM "buurt"');
    expect(plan?.dimensionColumn).toBeUndefined();
  });

  it("groups by a dimension, joining along the declared relationship", () => {
    const plan = buildQuery(model(), {
      measures: ["inwoners"],
      dimension: "gemeente_naam",
      limit: 10,
    });
    expect(plan?.sql).toBe(
      'SELECT "gemeente"."gm_naam" AS "dimension", SUM(inwoners) AS "inwoners" ' +
        'FROM "gemeente" LEFT JOIN "buurt" ON "gemeente"."gm_code" = "buurt"."gm_code" ' +
        "GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 10",
    );
    expect(plan?.dimensionColumn).toBe("dimension");
  });

  it("translates mean to AVG", () => {
    const detached = buildQuery(model(), { measures: ["los_meting"] });
    expect(detached?.sql).toContain("AVG(waarde)");
  });

  it("matches CBS codes in both nesting directions", () => {
    const plan = buildQuery(model(), {
      measures: ["inwoners"],
      filters: [{ kind: "area", column: "bu_code", codes: ["GM0882"] }],
    });
    // A gemeente code must select its buurten, and a buurt code its gemeente —
    // the same either-direction prefix rule the map's area filter uses.
    expect(plan?.sql).toContain(
      "(substr(CAST(\"bu_code\" AS VARCHAR), 3) LIKE '0882%' OR '0882' LIKE substr(CAST(\"bu_code\" AS VARCHAR), 3) || '%')",
    );
  });

  it("quotes value filters and escapes embedded quotes", () => {
    const plan = buildQuery(model(), {
      measures: ["inwoners"],
      filters: [{ kind: "value", column: "naam", values: ["s'-Hertogenbosch", 2026] }],
    });
    expect(plan?.sql).toContain("\"naam\" IN ('s''-Hertogenbosch', 2026)");
  });

  it("drops the widget when no join path exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = buildQuery(model(), {
      measures: ["los_meting"],
      dimension: "gemeente_naam",
    });
    expect(plan).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no join path"));
    warn.mockRestore();
  });

  it("drops the widget when two shortest join paths compete", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ambiguous = model({
      relationships: [
        { from: "buurt.gm_code", to: "gemeente.gm_code" },
        { from: "buurt.bu_code", to: "gemeente.hoofdbuurt" },
      ],
    });
    const plan = buildQuery(ambiguous, {
      measures: ["inwoners"],
      dimension: "gemeente_naam",
    });
    expect(plan).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ambiguous join path"));
    warn.mockRestore();
  });

  it("drops the widget when a measure is unknown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(buildQuery(model(), { measures: ["bestaat_niet"] })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown measure "bestaat_niet"'));
    warn.mockRestore();
  });
});
