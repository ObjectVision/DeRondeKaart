import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { DialogContent, DialogRoot } from "@/components/ui/dialog";

// Vitest runs without globals, so testing-library never registers its own
// afterEach — and the dialog portals into <body>, where a leaked render would
// make the next query ambiguous.
afterEach(cleanup);

/** The shared chrome geometry, as dialog.tsx spells it. */
const TOP = "top-13";
const SM_TOP = "sm:top-15";
const SM_MAX_H = "sm:max-h-[calc(100vh_-_4.75rem)]";

function popup(extra?: string): HTMLElement {
  render(() => (
    <DialogRoot open onOpenChange={() => {}}>
      <DialogContent class={extra}>content</DialogContent>
    </DialogRoot>
  ));
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error("no dialog rendered");
  return el;
}

describe("DialogContent geometry", () => {
  it("pins every dialog between the navigation card and the legend", () => {
    const el = popup();

    expect(el.className).toContain(TOP);
    expect(el.className).toContain(SM_TOP);
    expect(el.className).toContain(SM_MAX_H);
    expect(el.className).toContain("w-[min(64rem,calc(100vw-2rem))]");
  });

  it("is no longer vertically centred", () => {
    // The old base centred with top-1/2 + -translate-y-1/2, which every caller
    // then had to undo with translate-y-0. Both are gone; horizontal centring
    // stays.
    const el = popup();

    expect(el.className).not.toContain("top-1/2");
    expect(el.className).not.toContain("-translate-y-1/2");
    expect(el.className).toContain("-translate-x-1/2");
  });

  it("owns the scrollbar styling rather than leaving it to callers", () => {
    expect(popup().className).toContain("app-scrollbar");
  });

  it("keeps the shared geometry when a caller passes its own classes", () => {
    // `cn` is twMerge, so a caller class in a different group must not displace
    // the offsets — this is what "Over deze applicatie" does with typography.
    const el = popup("text-sm text-gray-600");

    expect(el.className).toContain("text-sm");
    expect(el.className).toContain(TOP);
    expect(el.className).toContain(SM_TOP);
  });
});
