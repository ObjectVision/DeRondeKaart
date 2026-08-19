import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { CombineLayersDialog } from "@/components/ui/CombineLayersDialog";
import type { LayerConfig } from "@/layers";

function layer(id: string, name: string, ruleNames: string[]): LayerConfig {
  return {
    id,
    name,
    source: `https://example.test/${id}.fgb`,
    format: "flatgeobuf",
    geostyler: {
      name,
      rules: ruleNames.map((ruleName) => ({
        name: ruleName,
        filter: ["==", "band0", 1],
        symbolizers: [{ kind: "Fill", color: "#ff0000" }],
      })),
    },
  } as LayerConfig;
}

const LAYERS = [layer("a", "Supermarkt", ["goed", "matig"]), layer("b", "Groen", ["hoog"])];

function renderDialog() {
  return render(() => (
    <CombineLayersDialog
      open
      onOpenChange={() => {}}
      layers={LAYERS}
      stepFor={() => undefined}
      onCreate={() => {}}
    />
  ));
}

function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText("Naam nieuwe laag") as HTMLInputElement;
}

// Vitest runs without globals, so testing-library never registers its own
// afterEach — and the dialog portals into <body>, where a leaked render would
// make the next query ambiguous.
afterEach(cleanup);

describe("CombineLayersDialog name field", () => {
  it("keeps the typed name when a criterion is ticked afterwards", () => {
    renderDialog();
    fireEvent.click(screen.getByText("goed"));
    expect(nameInput().value).toBe("Supermarkt goed");

    fireEvent.input(nameInput(), { target: { value: "Mijn combinatie" } });
    expect(nameInput().value).toBe("Mijn combinatie");

    fireEvent.click(screen.getByText("hoog"));
    expect(nameInput().value).toBe("Mijn combinatie");

    // Unticking must not revive the auto-name either.
    fireEvent.click(screen.getByText("goed"));
    expect(nameInput().value).toBe("Mijn combinatie");
  });

  it("follows the selection as long as the name is untouched", () => {
    renderDialog();
    fireEvent.click(screen.getByText("goed"));
    expect(nameInput().value).toBe("Supermarkt goed");

    fireEvent.click(screen.getByText("matig"));
    expect(nameInput().value).toBe("Supermarkt goed / matig");

    fireEvent.click(screen.getByText("hoog"));
    expect(nameInput().value).toBe("Supermarkt goed / matig + Groen hoog");
  });
});
