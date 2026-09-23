import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { TabStrip } from "@/components/ui/tab-strip";

const TABS = [
  { id: "een", label: "Een" },
  { id: "twee", label: "Twee" },
] as const;

afterEach(cleanup);

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
}

describe("TabStrip", () => {
  it("marks only the active tab, for assistive tech as well as the eye", () => {
    render(() => <TabStrip tabs={TABS} active="twee" onSelect={() => {}} />);

    const [een, twee] = buttons();
    expect(een.getAttribute("aria-selected")).toBe("false");
    expect(twee.getAttribute("aria-selected")).toBe("true");
    // Inactive tabs are the ones that carry the grey; the active tab's colour is
    // an inline style, since it is a runtime per-project value.
    expect(een.className).toContain("text-gray-500");
    expect(twee.className).not.toContain("text-gray-500");
  });

  /**
   * The transparent border is laid out on every tab, active or not. Dropping it
   * from the inactive ones reads as a tidy-up and costs nothing visible until
   * you switch tabs, at which point every label jumps up by 2px.
   */
  it("lays out the underline on inactive tabs too", () => {
    render(() => <TabStrip tabs={TABS} active="een" onSelect={() => {}} />);

    for (const button of buttons()) {
      expect(button.className).toContain("border-b-2");
      expect(button.className).toContain("border-transparent");
    }
  });

  /**
   * `onSelect` is handed the clicked button because callers use it to find the
   * scrolling dialog they sit in — DialogContent owns the overflow and exposes
   * no ref, so climbing from the button is the only way to reach it.
   */
  it("hands the clicked button to onSelect along with the id", () => {
    const onSelect = vi.fn();
    render(() => <TabStrip tabs={TABS} active="een" onSelect={onSelect} />);

    const twee = buttons()[1];
    twee.click();

    expect(onSelect).toHaveBeenCalledWith("twee", twee);
  });

  // type="button" keeps a strip inside a form from submitting it.
  it("renders tabs in order, as plain buttons", () => {
    render(() => <TabStrip tabs={TABS} active="een" onSelect={() => {}} />);

    expect(buttons().map((b) => b.textContent)).toEqual(["Een", "Twee"]);
    expect(buttons().every((b) => b.type === "button")).toBe(true);
  });
});
