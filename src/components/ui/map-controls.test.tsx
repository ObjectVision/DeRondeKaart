import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

import { MapControls } from "@/components/ui/map-controls";
import type { GeocodeResult } from "@/tools/geocode/types";

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

  /**
   * Search is one of the app's "chrome" dialogs, alongside Referentielagen and
   * the layer metainfo window. It was a popover pinned to the button; the modal
   * shell is what makes it a peer of those two, and the backdrop plus
   * `aria-modal` is the observable part of that.
   */
  it("opens as a modal window, not a popover", () => {
    openSearch();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The dimmed backdrop the family shares; a popover has none.
    expect(document.querySelector(".fixed.inset-0")).toBeTruthy();
  });

  it("focuses the search box so the user can type straight away", async () => {
    openSearch();
    const input = screen.getByPlaceholderText("Zoek een locatie...");

    // The focus call is deferred a frame so the element is in the document.
    await new Promise(requestAnimationFrame);

    expect(document.activeElement).toBe(input);
  });

  /**
   * A modal is dismissed by its own close button, not by toggling the button
   * that opened it — the opener is behind the backdrop and cannot be clicked.
   */
  it("closes on the window's close button", () => {
    openSearch();

    screen.getByTitle("Sluiten").click();

    expect(screen.queryByPlaceholderText("Zoek een locatie...")).toBeNull();
  });

  // The shell's own dismiss path, and the reason the suggestion list stops
  // Escape from bubbling while it is open.
  it("closes on Escape when there is no list to fold away first", () => {
    openSearch();
    const input = screen.getByPlaceholderText("Zoek een locatie...");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

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

  // The geocoder request itself is tested where it is built: the countrycodes
  // and "Bergen answers with Norway" cases in src/tools/geocode/nominatim.test.ts,
  // the endpoint and parsing in geocode/pdok.test.ts, and which candidate the
  // headless path takes in tools/zoom-to-location.test.ts. What this file covers
  // is the box itself — see "MapControls suggestions" below for the dropdown.

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

/**
 * The place-suggestion dropdown.
 *
 * The load-bearing tests here are the two Enter cases. The box is BOTH a
 * location search and, when a project enables it, a command bar — and only
 * `onCommand` can tell which a line of text is, after consulting the model. So
 * Enter must reach the command engine unless the user has explicitly
 * highlighted a candidate. Get that wrong and "zet apotheek aan" silently
 * geocodes instead, with nothing on screen to explain it.
 */
describe("MapControls suggestions", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const VENLO = { id: "1", label: "Gemeente Venlo", kind: "gemeente", center: [6.15, 51.39] as [number, number] };
  const ARCEN = { id: "2", label: "Arcen, Venlo", kind: "woonplaats", center: [6.18, 51.47] as [number, number] };

  /** Open the popover with suggestion handlers wired up. */
  type SuggestFn = (query: string, signal: AbortSignal) => Promise<GeocodeResult[]>;

  function openWithSuggest(
    results = [VENLO, ARCEN],
    onSuggest = vi.fn<SuggestFn>(async () => results),
  ) {
    const onPick = vi.fn();
    const onCommand = vi.fn(async () => null);
    render(() => (
      <MapControls
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onSuggest={onSuggest}
        onPick={onPick}
        onCommand={onCommand}
      />
    ));
    screen.getAllByTitle("Zoeken")[0].click();
    const input = screen.getByPlaceholderText("Zoek een locatie...") as HTMLInputElement;
    return { input, onSuggest, onPick, onCommand };
  }

  /** Type into the input the way a user does, firing the input event. */
  function type(input: HTMLInputElement, text: string) {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Press a key on the input, and report whether the default was prevented. */
  function press(input: HTMLInputElement, key: string): boolean {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }

  /** Let the debounce elapse and the suggestion promise settle. */
  async function settle() {
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeTruthy());
  }

  it("lists candidates after the debounce", async () => {
    vi.useFakeTimers();
    const { input } = openWithSuggest();

    type(input, "Venlo");
    await settle();

    expect(screen.getByText("Gemeente Venlo")).toBeTruthy();
    expect(screen.getByText("Arcen, Venlo")).toBeTruthy();
  });

  /**
   * A request per keystroke would put five geocoder calls behind the word
   * "Venlo". The debounce is what makes as-you-type affordable.
   */
  it("asks once for a burst of keystrokes", async () => {
    vi.useFakeTimers();
    const { input, onSuggest } = openWithSuggest();

    for (const text of ["V", "Ve", "Ven", "Venl", "Venlo"]) {
      type(input, text);
      vi.advanceTimersByTime(50);
    }
    await settle();

    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith("Venlo", expect.anything());
  });

  it("does not ask about a single character", async () => {
    vi.useFakeTimers();
    const { input, onSuggest } = openWithSuggest();

    type(input, "V");
    vi.advanceTimersByTime(300);
    await Promise.resolve();

    expect(onSuggest).not.toHaveBeenCalled();
  });

  /**
   * Without an abort, a slow answer for "Berg" can land after a fast one for
   * "Bergen" and replace a correct list with a stale one.
   */
  it("aborts a superseded request", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const onSuggest = vi.fn(async (_q: string, signal: AbortSignal) => {
      signals.push(signal);
      return [VENLO];
    });
    const { input } = openWithSuggest([VENLO], onSuggest);

    type(input, "Berg");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    type(input, "Bergen");
    await settle();

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("walks the list with the arrow keys", async () => {
    vi.useFakeTimers();
    const { input } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    press(input, "ArrowDown");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

    press(input, "ArrowDown");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  /** Stepping up from nothing selected reaches the last item. */
  it("wraps from the top of the list back to the bottom", async () => {
    vi.useFakeTimers();
    const { input } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    press(input, "ArrowUp");

    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  /**
   * THE guard on the command path. Nothing highlighted means the text is the
   * user's own, and only the command engine may decide what it means.
   */
  it("runs the typed text as a command when nothing is highlighted", async () => {
    vi.useFakeTimers();
    const { input, onCommand, onPick } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    const prevented = press(input, "Enter");
    input.closest("form")?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(prevented).toBe(false);
    expect(onCommand).toHaveBeenCalledWith("Venlo");
    expect(onPick).not.toHaveBeenCalled();
  });

  /**
   * The mirror image: a highlighted candidate is an explicit choice, and it
   * must NOT also submit — the form would otherwise geocode the label a second
   * time through the command engine.
   */
  it("picks the highlighted candidate without submitting", async () => {
    vi.useFakeTimers();
    const { input, onCommand, onPick } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    press(input, "ArrowDown");
    const prevented = press(input, "Enter");
    await Promise.resolve();

    expect(prevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(VENLO);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("picks on mousedown and puts the label in the box", async () => {
    vi.useFakeTimers();
    const { input, onPick } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    screen
      .getAllByRole("option")[1]
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(onPick).toHaveBeenCalledWith(ARCEN);
    expect(input.value).toBe("Arcen, Venlo");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("folds the list away on Escape but leaves the box open", async () => {
    vi.useFakeTimers();
    const { input } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    press(input, "Escape");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByPlaceholderText("Zoek een locatie...")).toBeTruthy();
  });

  /**
   * Reopening starts clean — no stale list, and no query left in the box from
   * a search the user has since forgotten about.
   */
  it("forgets the previous search when reopened", async () => {
    vi.useFakeTimers();
    const { input } = openWithSuggest();
    type(input, "Venlo");
    await settle();

    screen.getByTitle("Sluiten").click();
    screen.getAllByTitle("Zoeken")[0].click();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(
      screen.getByPlaceholderText<HTMLInputElement>("Zoek een locatie...").value,
    ).toBe("");
  });

  /**
   * Dictation and suggestions must not fight each other.
   *
   * Partials stream into the box a word at a time while the user is still
   * speaking. Each one is a programmatic write, which raises no input event, so
   * none of them reaches the debounce — one geocode for the finished sentence,
   * not one per word. This is why the debounce lives in `onInput` rather than
   * in an effect on the query signal, and an effect would silently undo it.
   */
  it("geocodes the finished utterance, not each spoken word", async () => {
    vi.useFakeTimers();
    config.textToTool = true;
    config.speechToText = true;
    const onSuggest = vi.fn(async () => [VENLO]);
    const onPick = vi.fn();
    const noopCommand = async () => null;
    const models = { voskReady: () => true, start: () => {} } as never;
    const onDictate = async (onPartial: (t: string) => void) => {
      onPartial("Ven");
      onPartial("Venlo cen");
      return "Venlo centrum";
    };
    render(() => (
      <MapControls
        onZoomIn={() => {}}
        onZoomOut={() => {}}
        onCommand={noopCommand}
        onSuggest={onSuggest}
        onPick={onPick}
        models={models}
        onDictate={onDictate}
      />
    ));
    screen.getByTitle("Zoeken of opdracht geven").click();

    screen.getByTitle("Inspreken").click();
    await vi.waitFor(() => expect(onSuggest).toHaveBeenCalled());
    vi.advanceTimersByTime(300);

    expect(onSuggest).toHaveBeenCalledTimes(1);
    expect(onSuggest).toHaveBeenCalledWith("Venlo centrum", expect.anything());
    config.textToTool = false;
    config.speechToText = false;
  });

  // Without handlers the box is exactly the submit-only search it always was.
  it("stays a plain search box when no suggestion handler is given", async () => {
    vi.useFakeTimers();
    render(() => <MapControls onZoomIn={() => {}} onZoomOut={() => {}} />);
    screen.getAllByTitle("Zoeken")[0].click();
    const input = screen.getByPlaceholderText("Zoek een locatie...") as HTMLInputElement;

    type(input, "Venlo");
    vi.advanceTimersByTime(300);
    await Promise.resolve();

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
