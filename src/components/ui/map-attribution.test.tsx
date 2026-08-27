import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { MapAttribution } from "@/components/ui/map-attribution";

/**
 * The first-visit guide.
 *
 * The failure that matters is asymmetric: not opening costs a visitor the
 * explanation once, while failing to record the visit greets them with a modal
 * on every single load, forever. The close-then-remount case below is the guard
 * for that.
 */
const GUIDE_SEEN_KEY = "guide-seen";

/** The dialog renders only while open, so its presence IS the open state. */
const dialog = () => document.querySelector('[role="dialog"]');

const closeButton = (): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Sluiten"]');
  if (!el) throw new Error("the dialog is not open");
  return el;
};

/** The toolbutton that opens the guide by hand. */
const helpButton = (): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>('button[aria-label="Over de applicatie"]');
  if (!el) throw new Error("no help button");
  return el;
};

describe("MapAttribution first-visit guide", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("opens by itself on a first visit when the project asks for it", () => {
    render(() => <MapAttribution autoOpen />);

    expect(dialog()).not.toBeNull();
  });

  /**
   * App renders two of these — the top-nav chrome row and the sidebar toolbar —
   * and the sidebar's arrives as an eagerly-constructed JSX prop, so both run
   * their setup even though only one is ever displayed. Both auto-opening puts
   * two portalled windows on screen: the second's backdrop dims the first,
   * leaving the loser's content visible below the winner as undimmed spill.
   */
  it("opens exactly one window when two instances are mounted", () => {
    render(() => (
      <>
        <MapAttribution autoOpen />
        <MapAttribution autoOpen />
      </>
    ));

    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  });

  it("stays shut when this browser has already seen it", () => {
    localStorage.setItem(GUIDE_SEEN_KEY, "1");

    render(() => <MapAttribution autoOpen />);

    expect(dialog()).toBeNull();
  });

  it("stays shut, and records nothing, when the project has not opted in", () => {
    render(() => <MapAttribution />);

    expect(dialog()).toBeNull();
    // Nothing was shown, so nothing may be marked as seen: writing here would
    // suppress the guide for a project that later turns the flag on.
    expect(localStorage.getItem(GUIDE_SEEN_KEY)).toBeNull();
  });

  it("does not greet the same browser twice", () => {
    render(() => <MapAttribution autoOpen />);
    closeButton().click();
    expect(dialog()).toBeNull();
    cleanup();

    render(() => <MapAttribution autoOpen />);

    expect(dialog()).toBeNull();
  });

  // Escape and the backdrop reach the component only through DialogRoot's
  // onOpenChange — a close path that skipped the flag would leave the guide
  // reappearing forever for anyone who dismisses it with the keyboard.
  it("counts an Escape dismissal as seen", () => {
    render(() => <MapAttribution autoOpen />);

    dialog()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(dialog()).toBeNull();
    expect(localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
  });

  /**
   * The tabs swap the window's content; they never stack. Both panels visible
   * at once reads as the Attributie list printed over the Handleiding.
   */
  it("shows one tab panel at a time, in the same window", () => {
    render(() => <MapAttribution autoOpen />);

    const tab = (label: string): HTMLButtonElement => {
      const el = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!el) throw new Error(`no tab ${label}`);
      return el;
    };
    // Headings unique to each panel.
    const handleidingShown = () => document.body.textContent?.includes("Thema's en kaartlagen");
    const attributieShown = () => document.body.textContent?.includes("Kaartgegevens");

    expect(handleidingShown()).toBe(true);
    expect(attributieShown()).toBe(false);

    tab("Attributie").click();

    expect(attributieShown()).toBe(true);
    expect(handleidingShown()).toBe(false);
    // One window throughout — a second dialog would mean two stacked modals.
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);

    tab("Handleiding").click();

    expect(handleidingShown()).toBe(true);
    expect(attributieShown()).toBe(false);
  });

  /**
   * A retained scroll offset opens the incoming tab already scrolled past its
   * own heading, which reads as the panel being drawn over the previous one.
   */
  it("returns to the top of the window when switching tabs", () => {
    render(() => <MapAttribution autoOpen />);

    const win = document.querySelector('[role="dialog"]') as HTMLElement;
    // jsdom never lays out, so scrollTop stays writable at whatever we set.
    win.scrollTop = 500;

    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((b) => b.textContent?.trim() === "Attributie")!
      .click();

    expect(win.scrollTop).toBe(0);
  });

  it("counts opening it from the toolbutton as seen", () => {
    render(() => <MapAttribution />);

    helpButton().click();
    expect(dialog()).not.toBeNull();
    helpButton().click();

    expect(dialog()).toBeNull();
    expect(localStorage.getItem(GUIDE_SEEN_KEY)).toBe("1");
  });
});
