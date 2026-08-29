import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

import { MapControls } from "@/components/ui/map-controls";

/**
 * The microphone renders only when the project enables both features, and
 * `commandMode` also switches the placeholder. These are per-test switches
 * rather than a blanket mock so the search-only tests keep exercising the
 * default configuration.
 */
const config = vi.hoisted(() => ({ textToTool: false, speechToText: false }));

vi.mock("@/config/map-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/map-config")>()),
  textToToolEnabled: () => config.textToTool,
  speechToTextEnabled: () => config.speechToText,
}));

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

  // The geocoder request — countrycodes and the "Bergen answers with Norway"
  // case — moved to src/tools/zoom-to-location.test.ts along with the logic
  // itself, now that the search box and the command bar share one tool.

  /**
   * Dictation fills the box and stops. It used to run the command itself, which
   * meant a misheard layer or place name acted on the map before the user could
   * see the words — and left text in the box that had already been used. The
   * microphone is an input method, so it must end where typing begins.
   */
  describe("dictation", () => {
    afterEach(() => {
      config.textToTool = false;
      config.speechToText = false;
    });

    /** Render with the mic enabled and a ready model, then open the popover. */
    function openWithMic(overrides: Partial<Parameters<typeof MapControls>[0]> = {}) {
      config.textToTool = true;
      config.speechToText = true;
      // Declared outside the JSX: an async arrow written inline reads to
      // solid/reactivity as an async tracked scope, which is an error.
      const noopCommand = async () => null;
      // `start` too: opening the popover is what kicks off the downloads, and
      // omitting it throws inside the click handler.
      const models = { voskReady: () => true, start: () => {} } as never;
      render(() => (
        <MapControls
          onZoomIn={() => {}}
          onZoomOut={() => {}}
          onCommand={noopCommand}
          models={models}
          {...overrides}
        />
      ));
      // In command mode the toggle is titled "Zoeken of opdracht geven"; only
      // the submit button inside the form keeps the plain "Zoeken".
      screen.getByTitle("Zoeken of opdracht geven").click();
    }

    const box = () =>
      screen.getByPlaceholderText<HTMLInputElement>("Zoek of geef een opdracht...");

    it("puts the spoken text in the box", async () => {
      openWithMic({ onDictate: async () => "open kaart apotheek" });

      screen.getByTitle("Inspreken").click();
      await Promise.resolve();

      expect(box().value).toBe("open kaart apotheek");
    });

    it("does not run the command by itself", async () => {
      const onCommand = vi.fn(async () => null);
      openWithMic({ onDictate: async () => "open kaart apotheek", onCommand });

      screen.getByTitle("Inspreken").click();
      await Promise.resolve();

      expect(onCommand).not.toHaveBeenCalled();
    });

    // The words should appear while the user is still talking, not only at the
    // end — otherwise the box sits empty through the whole utterance.
    it("shows partial results as they arrive", async () => {
      openWithMic({
        onDictate: async (onPartial) => {
          onPartial("open kaart");
          return "open kaart apotheek";
        },
      });

      screen.getByTitle("Inspreken").click();
      expect(box().value).toBe("open kaart");

      await Promise.resolve();
      expect(box().value).toBe("open kaart apotheek");
    });

    // Handing focus back is what makes the result editable and lets Enter send
    // it, so the mic leads naturally into the keyboard.
    it("focuses the box with the caret at the end", async () => {
      openWithMic({ onDictate: async () => "apotheek" });

      screen.getByTitle("Inspreken").click();
      await Promise.resolve();

      expect(document.activeElement).toBe(box());
      expect(box().selectionStart).toBe("apotheek".length);
    });

    // An empty utterance must not wipe what is already typed.
    it("leaves the box alone when nothing was heard", async () => {
      openWithMic({ onDictate: async () => "   " });
      box().value = "Maastricht";
      box().dispatchEvent(new Event("input", { bubbles: true }));

      screen.getByTitle("Inspreken").click();
      await Promise.resolve();

      expect(box().value).toBe("Maastricht");
    });

    it("explains a refused microphone rather than looking dead", async () => {
      openWithMic({
        onDictate: () => Promise.reject(new Error("Permission denied")),
      });

      screen.getByTitle("Inspreken").click();
      await Promise.resolve();
      await Promise.resolve();

      expect(screen.getByText("Geen toegang tot de microfoon.")).toBeTruthy();
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
