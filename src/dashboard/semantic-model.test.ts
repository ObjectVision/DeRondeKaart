import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildSemanticModel, withTableUrls } from "@/dashboard/semantic-model";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const TABLE = {
  name: "buurt",
  url: "https://example.test/buurt.parquet",
  key: "bu_code",
  columns: [{ name: "inwoners", role: "measure", label: "Inwoners" }],
};

describe("buildSemanticModel", () => {
  it("keeps a valid model and defaults an unrecognised aggregation", () => {
    const model = buildSemanticModel({
      tables: [TABLE],
      measures: [
        {
          id: "inwoners",
          table: "buurt",
          expression: "inwoners",
          aggregation: "median",
          label: "Inwoners",
          format: "number",
        },
      ],
    });
    expect(model.tables.get("buurt")?.url).toBe("https://example.test/buurt.parquet");
    // Lenient where charts.json is lenient: one bad enum is a typo, not a
    // reason to lose the measure.
    expect(model.measures.get("inwoners")?.aggregation).toBe("sum");
  });

  it("drops entries that name an unknown table", () => {
    const model = buildSemanticModel({
      tables: [TABLE],
      measures: [
        { id: "zweef", table: "bestaat_niet", expression: "x", aggregation: "sum", label: "X" },
      ],
      dimensions: [
        { id: "zweef_dim", table: "bestaat_niet", column: "x", label: "X" },
      ],
      relationships: [{ from: "buurt.gm_code", to: "bestaat_niet.gm_code" }],
    });
    expect(model.measures.size).toBe(0);
    expect(model.dimensions.size).toBe(0);
    expect(model.relationships).toHaveLength(0);
  });

  it("drops a table missing its url or key, and keeps the first of a duplicate id", () => {
    const model = buildSemanticModel({
      tables: [
        TABLE,
        { name: "buurt", url: "https://example.test/other.parquet", key: "bu_code" },
        { name: "kapot", key: "id" },
      ],
    });
    expect(model.tables.size).toBe(1);
    expect(model.tables.get("buurt")?.url).toBe("https://example.test/buurt.parquet");
  });

  it("yields an empty model for a non-object body", () => {
    const model = buildSemanticModel("nee");
    expect(model.tables.size).toBe(0);
    expect(model.measures.size).toBe(0);
  });
});

describe("withTableUrls", () => {
  it("re-points a known table and ignores an unknown one", () => {
    const model = buildSemanticModel({ tables: [TABLE] });
    const next = withTableUrls(model, {
      buurt: "https://example.test/2027.parquet",
      spook: "https://example.test/x.parquet",
    });
    expect(next.tables.get("buurt")?.url).toBe("https://example.test/2027.parquet");
    expect(next.tables.has("spook")).toBe(false);
    // The original is left alone — callers may still be querying it.
    expect(model.tables.get("buurt")?.url).toBe("https://example.test/buurt.parquet");
  });
});
