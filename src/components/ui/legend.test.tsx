import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { Legend } from "@/components/ui/legend";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { LayerConfig } from "@/layers";

afterEach(cleanup);

function entry(id: string, name: string, meta?: string): LayerEntry {
  return {
    config: {
      id,
      name,
      source: `https://example.test/${id}.tif`,
      format: "cog",
      meta,
      geostyler: {
        name,
        rules: [{ name: "1 van 1 criteria", symbolizers: [{ kind: "Fill", color: "#3288bd" }] }],
      },
    } as LayerConfig,
  };
}

function renderLegend(entries: LayerEntry[], onOpenMeta: (id: string) => void) {
  return render(() => (
    <Legend
      entries={entries}
      hiddenIds={new Set()}
      hiddenRules={new Map()}
      dimmedIds={new Set()}
      layerSteps={new Map()}
      playingIds={new Set()}
      onToggle={() => {}}
      onToggleDim={() => {}}
      onToggleRule={() => {}}
      onTogglePlay={() => {}}
      onSetStep={() => {}}
      onRemove={() => {}}
      onOpenMeta={(id) => onOpenMeta(id)}
    />
  ));
}

/** Reveal a row's actions — the info button sits behind the row toggle. */
function expandRow(index: number) {
  fireEvent.click(screen.getAllByTitle("Acties tonen")[index]);
}

describe("Legend info button", () => {
  it("gives a combination its own icon, always enabled, opening its metainfo", () => {
    const opened: string[] = [];
    renderLegend([entry("filter__1", "Mijn combinatie")], (id) => opened.push(id));
    expandRow(0);

    const button = screen.getByLabelText("Informatie over combinatie Mijn combinatie");
    expect(button.hasAttribute("disabled")).toBe(false);
    // Inline SVG, tinted with the chrome colour like the glyphs beside it.
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.style.color).not.toBe("");

    fireEvent.click(button);
    expect(opened).toEqual(["filter__1"]);
  });

  it("keeps an ordinary layer without meta on the disabled info glyph", () => {
    renderLegend([entry("groen", "Groen")], () => {});
    expandRow(0);

    const button = screen.getByLabelText("Informatie Groen");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.querySelector("svg")).toBeNull();
  });
});
