import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

import { ChartCard } from "@/components/charts/ChartCard";
import type { ChartConfig } from "@/layers/charts";
import type { ChartDatum, ResolvedChart } from "@/layers/chart-data";

afterEach(cleanup);

function chart(type: ChartConfig["type"], data: ChartDatum[]): ResolvedChart {
  return {
    config: {
      id: "c",
      title: "Inwoners",
      type,
      data: { fields: [] },
      aggregation: "sum",
      format: "number",
    },
    data,
    total: data.reduce((sum, datum) => sum + datum.value, 0),
  };
}

const SINGLE: ChartDatum[] = [
  { label: "0-17", value: 10, color: "#111111" },
  { label: "18+", value: 30, color: "#222222" },
];

const COMPARED: ChartDatum[] = [
  { label: "0-17", value: 10, color: "#111111", series: { label: "Weert", color: "#e41a1c" } },
  { label: "18+", value: 30, color: "#222222", series: { label: "Weert", color: "#e41a1c" } },
  { label: "0-17", value: 20, color: "#111111", series: { label: "Venlo", color: "#377eb8" } },
  { label: "18+", value: 40, color: "#222222", series: { label: "Venlo", color: "#377eb8" } },
];

describe("multi-series charts", () => {
  it("draws one bar per series and keeps one category label", () => {
    render(() => <ChartCard chart={chart("bar", COMPARED)} />);
    const bars = document.querySelectorAll("rect");
    expect(bars).toHaveLength(4);
    // One axis label per category, not one per bar — four bars, two labels.
    const categoryLabels = [...document.querySelectorAll("svg > text")];
    expect(categoryLabels).toHaveLength(2);
    // Bars take the series colour, not the datum's own.
    const fills = new Set([...bars].map((bar) => bar.getAttribute("fill")));
    expect(fills).toEqual(new Set(["#e41a1c", "#377eb8"]));
  });

  it("draws one line per series with a legend", () => {
    render(() => <ChartCard chart={chart("line", COMPARED)} />);
    // Two series paths and no area fill (four translucent fills read as mud).
    const paths = [...document.querySelectorAll("path")];
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.getAttribute("fill") === "none")).toBe(true);
    expect(screen.getByText("Weert")).toBeTruthy();
    expect(screen.getByText("Venlo")).toBeTruthy();
  });

  it("splits a donut into one ring per series", () => {
    render(() => <ChartCard chart={chart("donut", COMPARED)} />);
    expect(document.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByText("Weert")).toBeTruthy();
  });

  it("renders single-series data exactly as before", () => {
    render(() => <ChartCard chart={chart("line", SINGLE)} />);
    const paths = [...document.querySelectorAll("path")];
    // Area fill plus the line, and no legend.
    expect(paths).toHaveLength(2);
    expect(paths.some((path) => path.getAttribute("fill") === "#1c5cab")).toBe(true);
    expect(screen.queryByText("Weert")).toBeNull();
  });
});
