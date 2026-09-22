import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

import { SearchDialog } from "@/components/ui/SearchDialog";

// Vitest runs without globals, so testing-library never registers its own
// afterEach — and the dialog portals into <body>, where a leaked render would
// make the next query ambiguous.
afterEach(cleanup);

const CLEAR_LABEL = "Zoekopdracht wissen";

/**
 * `onSuggest` is deliberately left out: without it `requestSuggestions` bails
 * before any network path, so these cases need no fake timers for the 250 ms
 * debounce.
 */
function renderDialog(onCommand?: (text: string) => Promise<string | null>) {
  render(() => <SearchDialog open onOpenChange={() => {}} onCommand={onCommand} />);
  return screen.getByRole("combobox") as HTMLInputElement;
}

describe("SearchDialog clear button", () => {
  it("stays hidden while the field is empty", () => {
    renderDialog();
    expect(screen.queryByLabelText(CLEAR_LABEL)).toBeNull();
  });

  it("appears once text is typed and empties the field when clicked", () => {
    const input = renderDialog();

    fireEvent.input(input, { target: { value: "Maastricht" } });
    expect(input.value).toBe("Maastricht");

    fireEvent.click(screen.getByLabelText(CLEAR_LABEL));

    expect(input.value).toBe("");
    // It removes itself along with the text it cleared.
    expect(screen.queryByLabelText(CLEAR_LABEL)).toBeNull();
  });

  it("offers itself for whitespace too, which the submit path would reject", () => {
    const input = renderDialog();
    fireEvent.input(input, { target: { value: "   " } });
    expect(screen.getByLabelText(CLEAR_LABEL)).toBeTruthy();
  });

  it("does not submit the form", () => {
    // Guards the `type="button"`: a default-type button inside the form would
    // search for the very text it is about to erase.
    const onCommand = vi.fn(async () => null);
    const input = renderDialog(onCommand);

    fireEvent.input(input, { target: { value: "Maastricht" } });
    fireEvent.click(screen.getByLabelText(CLEAR_LABEL));

    expect(onCommand).not.toHaveBeenCalled();
  });
});
