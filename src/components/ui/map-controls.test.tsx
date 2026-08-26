import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

import { MapControls } from "@/components/ui/map-controls";

/**
 * The search box is created when the popover opens, not with the page.
 *
 * That is the whole reason this is tested: the input carried an `autofocus`
 * attribute, which browsers honour only for an element present in the initial
 * HTML. On an element a framework inserts later it does nothing, so the user had
 * to click the box before typing — a failure with nothing on screen to explain
 * it.
 */
function openSearch() {
  const view = render(() => <MapControls onZoomIn={() => {}} onZoomOut={() => {}} />);
  // The toggle and the submit button share the "Zoeken" title; the toggle is
  // the one that exists before the form does.
  const toggle = screen.getAllByTitle("Zoeken")[0];
  toggle.click();
  return view;
}

describe("MapControls search", () => {
  afterEach(cleanup);

  it("opens the search box on the search button", () => {
    openSearch();

    expect(screen.getByPlaceholderText("Zoek een locatie...")).toBeTruthy();
  });

  it("focuses the search box so the user can type straight away", async () => {
    openSearch();
    const input = screen.getByPlaceholderText("Zoek een locatie...");

    // The focus call is deferred a frame so the element is in the document.
    await new Promise(requestAnimationFrame);

    expect(document.activeElement).toBe(input);
  });

  it("closes again on a second click", () => {
    openSearch();
    screen.getAllByTitle("Zoeken")[0].click();

    expect(screen.queryByPlaceholderText("Zoek een locatie...")).toBeNull();
  });

  /**
   * The submit icon states whether the button will do anything: grey while
   * `handleSearch` would refuse the query, the project accent once it would act.
   */
  describe("submit icon", () => {
    const sendIcon = () =>
      document.querySelector<HTMLElement>('form span.material-symbols-outlined');

    function type(text: string) {
      const input = screen.getByPlaceholderText<HTMLInputElement>("Zoek een locatie...");
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("is greyed out while the box is empty", () => {
      openSearch();

      expect(sendIcon()?.className).toContain("text-gray-400");
      expect(sendIcon()?.style.color).toBe("");
    });

    it("takes the chrome accent once there is a query", () => {
      openSearch();
      type("Maastricht");

      expect(sendIcon()?.className).not.toContain("text-gray-400");
      // chromeIconColor()'s default, as no map.json is loaded here.
      expect(sendIcon()?.style.color).toBeTruthy();
    });

    // Whitespace is not a query: handleSearch trims before deciding, so the
    // colour must agree or the button looks live while refusing to act.
    it("stays greyed out for whitespace only", () => {
      openSearch();
      type("   ");

      expect(sendIcon()?.className).toContain("text-gray-400");
    });
  });

  // Submitting an empty box must not reach the geocoder.
  it("does not search on an empty query", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    openSearch();

    const form = screen.getByPlaceholderText("Zoek een locatie...").closest("form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
