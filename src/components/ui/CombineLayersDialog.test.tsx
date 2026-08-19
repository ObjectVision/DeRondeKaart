import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { CombineLayersDialog } from "@/components/ui/CombineLayersDialog";
import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import type { LayerConfig, ScoreClass } from "@/layers";

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

type CreateHandler = (name: string, refs: ClassRef[], classes: ScoreClass[]) => void;

function renderDialog(onCreate: CreateHandler = () => {}) {
  return render(() => (
    <CombineLayersDialog
      open
      onOpenChange={() => {}}
      layers={LAYERS}
      stepFor={() => undefined}
      onCreate={onCreate}
    />
  ));
}

function labelInput(score: number): HTMLInputElement {
  return screen.getByLabelText("Tekst voor klasse " + score) as HTMLInputElement;
}

function colorInput(score: number): HTMLInputElement {
  return screen.getByLabelText("Kleur voor klasse " + score) as HTMLInputElement;
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

describe("CombineLayersDialog legend preview", () => {
  it("shows one class per criterion, with the default label and colour", () => {
    renderDialog();
    expect(screen.queryByLabelText("Tekst voor klasse 1")).toBeNull();

    fireEvent.click(screen.getByText("goed"));
    expect(labelInput(1).value).toBe("1 van 1 criteria");
    expect(screen.queryByLabelText("Tekst voor klasse 2")).toBeNull();

    fireEvent.click(screen.getByText("hoog"));
    expect(labelInput(1).value).toBe("1 van 2 criteria");
    expect(labelInput(2).value).toBe("2 van 2 criteria");
    // The ramp takes its ends for two criteria: red for the weakest score.
    expect(colorInput(1).value).toBe("#d53e4f");
  });

  it("resets edited labels when the criteria change", () => {
    renderDialog();
    fireEvent.click(screen.getByText("goed"));
    fireEvent.input(labelInput(1), { target: { value: "Voldoet" } });
    expect(labelInput(1).value).toBe("Voldoet");

    fireEvent.click(screen.getByText("hoog"));
    expect(labelInput(1).value).toBe("1 van 2 criteria");
  });

  it("hands the edited legend to onCreate, falling back for a cleared label", () => {
    const created: ScoreClass[][] = [];
    renderDialog((_name, _refs, classes) => created.push(classes));

    fireEvent.click(screen.getByText("goed"));
    fireEvent.click(screen.getByText("hoog"));
    fireEvent.input(labelInput(1), { target: { value: "Half" } });
    fireEvent.input(colorInput(1), { target: { value: "#123456" } });
    fireEvent.input(labelInput(2), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Laag maken"));

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual([
      { label: "Half", color: "#123456" },
      { label: "2 van 2 criteria", color: "#3288bd" },
    ]);
  });
});
