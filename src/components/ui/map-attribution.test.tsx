import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

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
const VERSCHILKAART_SEEN_KEY = "verschilkaart-seen";

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

const tab = (label: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no tab ${label}`);
  return el;
};

/** The comparison-slider animation on the Verschilkaart tab. */
const sliderGif = (): HTMLImageElement => {
  const el = document.querySelector<HTMLImageElement>('img[src*="handleiding_links_rechts"]');
  if (!el) throw new Error("no slider animation");
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

  it("leaves nothing behind when the first-visit window is closed", () => {
    render(() => (
      <>
        <MapAttribution autoOpen />
        <MapAttribution autoOpen />
      </>
    ));

    closeButton().click();

    expect(dialog()).toBeNull();
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

  it("offers the three tabs, with Verschilkaart beside Handleiding", () => {
    render(() => <MapAttribution autoOpen />);

    const labels = [...document.querySelectorAll('[role="tab"]')].map((t) =>
      t.textContent?.trim(),
    );

    expect(labels).toEqual(["Handleiding", "Verschilkaart", "Attributie"]);
  });

  it("explains the comparison slider, with the animation", () => {
    render(() => <MapAttribution autoOpen />);

    tab("Verschilkaart").click();

    expect(document.body.textContent).toContain(
      "Met de verticale schuif of het handvat",
    );
    const gif = sliderGif();
    expect(gif.getAttribute("src")).toContain("handleiding_links_rechts.gif");
    // The Handleiding must be gone, not merely covered.
    expect(document.body.textContent).not.toContain("Thema's en kaartlagen");
  });

  /**
   * The animation is a play-once GIF, so replay means re-fetching it under a
   * URL the browser has not already finished decoding. Reusing the identical
   * src leaves the image sitting on its last frame — a click that does nothing.
   */
  it("changes the animation's src on click, so it can replay", () => {
    render(() => <MapAttribution autoOpen />);
    tab("Verschilkaart").click();

    const before = sliderGif().getAttribute("src");
    sliderGif().click();
    const after = sliderGif().getAttribute("src");

    expect(after).not.toBe(before);
    expect(after).toContain("handleiding_links_rechts.gif");
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

  /**
   * Comparison mode is ALWAYS driven from a signal that flips after mount.
   * Passing `comparisonActive` already true would pass even if the effect
   * never subscribed to it — which is the exact bug worth guarding against.
   */
  describe("Verschilkaart on first use of comparison mode", () => {
    const renderWithComparison = (
      props: { autoOpen?: boolean; enabled?: boolean } = {},
    ) => {
      const [active, setActive] = createSignal(false);
      render(() => (
        <MapAttribution
          autoOpen={props.autoOpen}
          showVerschilkaartOnFirstUse={props.enabled ?? true}
          comparisonActive={active()}
        />
      ));
      return setActive;
    };

    const onVerschilkaartTab = () =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ===
      "Verschilkaart";

    /**
     * App mounts two of these, and the sidebar's arrives as an eagerly
     * constructed JSX prop, so BOTH run this effect. Each holds its own
     * `useLocalFlag` signal, seeded from storage once at setup — so the first
     * instance writing the flag does NOT update the second's already-false
     * signal. Both then open, and closing the top one reveals the other still
     * sitting underneath.
     */
    it("opens exactly one window when two instances see comparison start", () => {
      const [active, setActive] = createSignal(false);
      render(() => (
        <>
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
        </>
      ));

      setActive(true);

      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });

    /**
     * One click on the X must close it for good.
     *
     * `onCleanup` inside a `createEffect` runs before every RE-RUN of that
     * effect, not just on unmount — so releasing the claim there hands it back
     * the next time comparison state changes, and the twin instance opens a
     * second window behind the first. The user sees a window that needs
     * closing twice.
     */
    it("closes for good on a single click, across later effect runs", () => {
      const [active, setActive] = createSignal(false);
      render(() => (
        <>
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
        </>
      ));
      setActive(true);
      expect(dialog()).not.toBeNull();

      // Anything that re-runs the effect: the maps' comparison state moving on.
      setActive(false);
      setActive(true);
      closeButton().click();

      expect(dialog()).toBeNull();
    });

    /**
     * The user-visible symptom of the twin bug: close the window that popped
     * up and nothing must be left behind it.
     */
    it("leaves nothing behind when the popped-up window is closed", () => {
      const [active, setActive] = createSignal(false);
      render(() => (
        <>
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
          <MapAttribution showVerschilkaartOnFirstUse comparisonActive={active()} />
        </>
      ));
      setActive(true);

      closeButton().click();

      expect(dialog()).toBeNull();
    });

    it("opens on the Verschilkaart tab when comparison mode starts", () => {
      const setActive = renderWithComparison();
      expect(dialog()).toBeNull();

      setActive(true);

      expect(dialog()).not.toBeNull();
      expect(onVerschilkaartTab()).toBe(true);
    });

    it("does nothing when the project has not opted in", () => {
      const setActive = renderWithComparison({ enabled: false });

      setActive(true);

      expect(dialog()).toBeNull();
      expect(localStorage.getItem(VERSCHILKAART_SEEN_KEY)).toBeNull();
    });

    it("fires only once, even across later comparison sessions", () => {
      const setActive = renderWithComparison();
      setActive(true);
      closeButton().click();
      expect(dialog()).toBeNull();

      setActive(false);
      setActive(true);

      expect(dialog()).toBeNull();
    });

    it("stays shut when this browser has already seen it", () => {
      localStorage.setItem(VERSCHILKAART_SEEN_KEY, "1");
      const setActive = renderWithComparison();

      setActive(true);

      expect(dialog()).toBeNull();
    });

    // The whole reason for a second storage key: a visitor who was greeted by
    // the first-visit Handleiding must still get the slider explained.
    it("fires even when the first-visit guide was already seen", () => {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
      const setActive = renderWithComparison();

      setActive(true);

      expect(dialog()).not.toBeNull();
      expect(onVerschilkaartTab()).toBe(true);
    });

    it("reuses the open first-visit window instead of stacking a second", () => {
      const setActive = renderWithComparison({ autoOpen: true });
      // The first-visit guide is up, on Handleiding.
      expect(dialog()).not.toBeNull();
      expect(onVerschilkaartTab()).toBe(false);

      setActive(true);

      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
      expect(onVerschilkaartTab()).toBe(true);
    });
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
