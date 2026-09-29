import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

// Both bodies are stubbed: this suite is about the window around them — which
// body a layer gets, and when the edit button shows — not their config loading.
vi.mock("@/components/ui/navigation/LeafMeta", () => ({
  LeafMeta: () => <div>published fragment</div>,
}));
vi.mock("@/components/ui/CombinationMeta", () => ({
  CombinationMeta: () => <div>generated toelichting</div>,
}));

import { LayerMetaDialog } from "@/components/ui/LayerMetaDialog";

afterEach(cleanup);

function renderDialog(id: string, onEditCombination?: (id: string) => void) {
  return render(() => (
    <LayerMetaDialog
      open
      onOpenChange={() => {}}
      layer={{ id, name: "Laag" }}
      onEditCombination={onEditCombination}
    />
  ));
}

describe("LayerMetaDialog", () => {
  it("shows a combination's generated metainfo and an edit button", () => {
    const edited: string[] = [];
    renderDialog("filter__3", (id) => edited.push(id));

    expect(screen.getByText("generated toelichting")).toBeTruthy();
    expect(screen.queryByText("published fragment")).toBeNull();

    fireEvent.click(screen.getByLabelText("Combinatie aanpassen"));
    expect(edited).toEqual(["filter__3"]);
  });

  it("shows an ordinary layer's published metainfo, without an edit button", () => {
    renderDialog("aandeel_j0_17", () => {});
    expect(screen.getByText("published fragment")).toBeTruthy();
    expect(screen.queryByLabelText("Combinatie aanpassen")).toBeNull();
  });

  it("hides the edit button when editing is not wired, as without combinations", () => {
    renderDialog("filter__3");
    expect(screen.queryByLabelText("Combinatie aanpassen")).toBeNull();
  });
});
