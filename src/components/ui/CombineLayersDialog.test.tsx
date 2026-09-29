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

/**
 * Edit mode: the dialog reopened from a combination's metainfo, pre-filled with
 * its choices. Saving goes to `onSave`, never `onCreate`.
 */
describe("CombineLayersDialog edit mode", () => {
  const INITIAL = {
    name: "Supermarkt goed + Groen hoog",
    refs: [
      { layerId: "a", ruleName: "goed" },
      { layerId: "b", ruleName: "hoog" },
    ],
    classes: [
      { label: "Half", color: "#123456" },
      { label: "Alles", color: "#abcdef" },
    ],
  };

  type SaveHandler = (name: string, refs: ClassRef[], classes: ScoreClass[]) => void;

  function renderEdit(
    initial = INITIAL,
    onSave: SaveHandler = () => {},
    onCreate: CreateHandler = () => {},
  ) {
    return render(() => (
      <CombineLayersDialog
        open
        onOpenChange={() => {}}
        layers={LAYERS}
        stepFor={() => undefined}
        initial={initial}
        onCreate={onCreate}
        onSave={onSave}
      />
    ));
  }

  function editNameInput(): HTMLInputElement {
    return screen.getByPlaceholderText("Naam laag") as HTMLInputElement;
  }

  it("opens with the combination's classes ticked", () => {
    renderEdit();
    const checked = screen
      .getAllByRole("checkbox")
      .filter((box) => box.getAttribute("aria-checked") === "true")
      // The label span, not the button's whole text: the checkbox glyph is a
      // Material ligature, so its textContent reads "check_box".
      .map((box) => box.querySelector("span.text-xs")?.textContent);
    expect(checked).toEqual(["goed", "hoog"]);
  });

  // The legend-reset effect runs on mount; without the skip it would replace the
  // combination's own legend with defaults before the user touched anything.
  it("keeps the combination's own legend on opening", () => {
    renderEdit();
    expect(labelInput(1).value).toBe("Half");
    expect(colorInput(2).value).toBe("#abcdef");
  });

  it("still resets the legend once the criteria change", () => {
    renderEdit();
    fireEvent.click(screen.getByText("matig"));
    expect(labelInput(1).value).toBe("1 van 2 criteria");
  });

  it("keeps a name the user typed at creation", () => {
    renderEdit({ ...INITIAL, name: "Mijn buurtscore" });
    fireEvent.click(screen.getByText("matig"));
    expect(editNameInput().value).toBe("Mijn buurtscore");
  });

  it("lets a generated name keep following the criteria", () => {
    renderEdit();
    fireEvent.click(screen.getByText("matig"));
    expect(editNameInput().value).toBe("Supermarkt goed / matig + Groen hoog");
  });

  it("saves through onSave with the edited selection, never onCreate", () => {
    const saved: [string, ClassRef[], ScoreClass[]][] = [];
    const created: string[] = [];
    renderEdit(
      INITIAL,
      (name, refs, classes) => saved.push([name, refs, classes]),
      (name) => created.push(name),
    );

    fireEvent.click(screen.getByText("hoog"));
    fireEvent.click(screen.getByText("Wijzigingen opslaan"));

    expect(created).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toBe("Supermarkt goed");
    expect(saved[0][1]).toEqual([{ layerId: "a", ruleName: "goed" }]);
    expect(saved[0][2]).toEqual([{ label: "1 van 1 criteria", color: "#3288bd" }]);
  });
});

/** A combination offered as a criterion: its classes are its score classes. */
describe("CombineLayersDialog with a combination as criterion", () => {
  const COMBI = layer("filter__7", "Voorzieningen", ["1 van 2 criteria", "Alles"]);

  function renderWith(
    props: { initial?: { name: string; refs: ClassRef[]; classes: ScoreClass[] } } = {},
    onCreate: CreateHandler = () => {},
    onSave?: CreateHandler,
  ) {
    return render(() => (
      <CombineLayersDialog
        open
        onOpenChange={() => {}}
        layers={[COMBI, LAYERS[1]]}
        stepFor={() => undefined}
        initial={props.initial}
        onCreate={onCreate}
        onSave={onSave}
      />
    ));
  }

  it("marks it as a combination", () => {
    renderWith();
    expect(screen.getByText("Combinatie")).toBeTruthy();
  });

  it("records the score of a ticked class, not just its label", () => {
    const created: ClassRef[][] = [];
    renderWith({}, (_name, refs) => created.push(refs));

    fireEvent.click(screen.getByText("Alles"));
    fireEvent.click(screen.getByText("hoog"));
    fireEvent.click(screen.getByText("Laag maken"));

    expect(created[0]).toEqual([
      { layerId: "filter__7", ruleName: "Alles", score: 2 },
      { layerId: "b", ruleName: "hoog" },
    ]);
  });

  // The source's label was renamed after this combination was built: the ref
  // still says "2 van 2 criteria", the rule now says "Alles". Score 2 matches.
  it("pre-checks by score after the source's label was renamed", () => {
    renderWith({
      initial: {
        name: "Afgeleid",
        refs: [{ layerId: "filter__7", ruleName: "2 van 2 criteria", score: 2 }],
        classes: [{ label: "1 van 1 criteria", color: "#3288bd" }],
      },
    });
    const alles = screen.getByText("Alles").closest("button");
    expect(alles?.getAttribute("aria-checked")).toBe("true");
  });
});
