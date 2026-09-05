import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import {
  chromeIconSize,
  chromeIconColor,
  speechToTextEnabled,
  textToToolEnabled,
} from "@/config/map-config";
import type { ModelLoader } from "@/ai/model-loader";
import type { GeocodeResult } from "@/tools/geocode/types";

interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /**
   * Run one command line. Resolves to a Dutch message when it could not be
   * carried out, so the bar can say why. Falls back to a location search
   * internally, so this is safe to call before any model has loaded.
   */
  onCommand?: (text: string) => Promise<string | null>;
  /** Model download state; absent when this project enables neither feature. */
  models?: ModelLoader;
  /**
   * Start dictation, resolving to the finished utterance. `onPartial` reports
   * words as they are recognised, for live feedback in the input.
   */
  onDictate?: (onPartial: (text: string) => void) => Promise<string>;
  /** Stop a dictation the user started. */
  onStopDictation?: () => void;
  /**
   * "vertical" (default) stacks the buttons (top-mode / right-edge usage);
   * "horizontal" lays them out as a row for the sidebar toolbar. Search is
   * always the last button and its popover expands to the right of it.
   */
  orientation?: "vertical" | "horizontal";
  /**
   * Ranked place candidates for the typed text, for the suggestion list.
   *
   * Optional: without it the box is exactly the submit-only search it was, so
   * a caller that wants no dropdown simply omits it.
   */
  onSuggest?: (query: string, signal: AbortSignal) => Promise<GeocodeResult[]>;
  /** Fly the map to the candidate the user picked. */
  onPick?: (result: GeocodeResult) => void;
  /** Show the location-search button (+ its popover). Defaults to `true`. */
  showSearch?: boolean;
  /** Show the zoom in/out buttons. Defaults to `true`. */
  showZoom?: boolean;
}

export function MapControls(props: MapControlsProps): JSX.Element {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");

  const showSearch = () => props.showSearch ?? true;
  const showZoom = () => props.showZoom ?? true;
  const horizontal = () => (props.orientation ?? "vertical") === "horizontal";
  /** Whether there is a query worth submitting; trimmed, as handleSearch tests. */
  const hasQuery = () => searchQuery().trim().length > 0;

  /** Dutch explanation of the last failed command, cleared on the next edit. */
  const [message, setMessage] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  /**
   * Whether this bar is a command bar at all. The geocoding path is unchanged
   * either way — `onCommand` falls back to a location search whenever the model
   * is missing, still downloading, or fails.
   */
  const commandMode = () => textToToolEnabled() && Boolean(props.onCommand);
  const micVisible = () => commandMode() && speechToTextEnabled();
  const micReady = () => props.models?.voskReady() ?? false;

  async function handleSearch(e: Event) {
    e.preventDefault();
    const text = searchQuery().trim();
    if (!text || busy()) return;

    setBusy(true);
    setMessage(null);
    // The command owns the outcome from here; a list of places to fly to would
    // only be stale once it has run.
    clearSuggestions();
    try {
      const failure = await props.onCommand?.(text);
      setMessage(failure ?? null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Place candidates for what is currently typed, and which one the keyboard
   * has highlighted.
   *
   * `-1` means "none" and is load-bearing: the first Enter must run the typed
   * text as a COMMAND, not fly to a guess. Starting at 0 would silently break
   * "zet apotheek aan" by geocoding it instead.
   */
  const [suggestions, setSuggestions] = createSignal<GeocodeResult[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(-1);

  /** Shortest query worth asking a geocoder about. */
  const MIN_SUGGEST_CHARS = 2;
  /** Quiet period after the last keystroke before asking. */
  const SUGGEST_DEBOUNCE_MS = 250;

  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestAbort: AbortController | undefined;

  function clearSuggestions() {
    setSuggestions([]);
    setActiveIndex(-1);
  }

  /**
   * Ask for candidates now, without waiting for the debounce.
   *
   * Each call cancels the previous request. Without that, a slow answer for
   * "Berg" can land after a fast one for "Bergen" and replace a correct list
   * with a stale one; the query re-check below closes the same race for a
   * response that had already resolved when the abort fired.
   */
  async function requestSuggestions(text: string) {
    suggestAbort?.abort();
    const query = text.trim();
    if (query.length < MIN_SUGGEST_CHARS || !props.onSuggest) {
      clearSuggestions();
      return;
    }

    const controller = new AbortController();
    suggestAbort = controller;
    try {
      const found = await props.onSuggest(query, controller.signal);
      if (controller.signal.aborted || searchQuery().trim() !== query) return;
      setSuggestions(found);
      // A fresh list starts with NOTHING highlighted, and this line is what
      // enforces it — not the signal's initial value, which is overwritten the
      // moment any list arrives. Highlight the first row here and Enter would
      // fly to a guess instead of running the user's command.
      setActiveIndex(-1);
    } catch {
      // `geocode` already swallows and logs its own failures; anything reaching
      // here would be an abort, which is not worth reporting to the user.
      if (!controller.signal.aborted) clearSuggestions();
    }
  }

  /** Queue a suggestion fetch for text the user typed. */
  function scheduleSuggestions(text: string) {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => void requestSuggestions(text), SUGGEST_DEBOUNCE_MS);
  }

  onCleanup(() => {
    clearTimeout(suggestTimer);
    suggestAbort?.abort();
  });

  /** Fly to a candidate and fold the list away. */
  function choose(result: GeocodeResult) {
    props.onPick?.(result);
    setSearchQuery(result.label);
    setMessage(null);
    clearSuggestions();
  }

  /**
   * Arrow keys walk the list, Enter acts on it, Escape folds it away.
   *
   * Enter only intercepts when something is highlighted; otherwise the form
   * submits as it always did, which is what keeps typed commands reaching
   * `onCommand` rather than the geocoder.
   */
  function handleKeyDown(e: KeyboardEvent) {
    const items = suggestions();
    if (items.length === 0) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // Wraps through -1 rather than past it, so stepping off either end brings
      // the user back to their own typed text.
      const next = activeIndex() + step;
      setActiveIndex(next > items.length - 1 ? -1 : next < -1 ? items.length - 1 : next);
      return;
    }

    if (e.key === "Enter" && activeIndex() >= 0) {
      e.preventDefault();
      choose(items[activeIndex()]);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      clearSuggestions();
    }
  }

  /** True while the microphone is live. */
  const [listening, setListening] = createSignal(false);

  /** The text input, so dictation can hand focus back to the user. */
  let inputRef: HTMLInputElement | undefined;

  /**
   * Dictate one utterance into the input, and stop there.
   *
   * Deliberately does NOT submit. Recognition is imperfect — a misheard place or
   * layer name should be a visible word the user can correct before anything
   * happens on the map, not a command that has already run. So the microphone
   * only fills the text box; sending stays the send button's job, exactly as it
   * is for typed input.
   *
   * A second click stops early, which is the way out if the recogniser never
   * hears an end-of-speech pause.
   */
  async function handleMic() {
    if (listening()) {
      props.onStopDictation?.();
      setListening(false);
      return;
    }

    setListening(true);
    setMessage(null);
    try {
      // Partials stream in as they are recognised, so the words appear while the
      // user is still speaking; the final result replaces them.
      const spoken = await props.onDictate?.((partial) => setSearchQuery(partial));
      setListening(false);
      if (!spoken?.trim()) return;

      setSearchQuery(spoken);
      // Focus the input with the caret at the end, so the text is immediately
      // editable and Enter sends it — the mic hands over to the keyboard.
      const input = inputRef;
      if (input) {
        input.focus();
        input.setSelectionRange(spoken.length, spoken.length);
      }
      // One fetch for the finished utterance, skipping the debounce. Partials
      // raise no input event, so this is the only suggestion request dictation
      // makes — and without it the box would sit there looking inert after the
      // user had just spoken a place name.
      void requestSuggestions(spoken);
    } catch (err) {
      setListening(false);
      // Most often a denied or unavailable microphone. In the embed that means
      // the parent page's iframe lacks allow="microphone" — silence here would
      // read as a dead button.
      setMessage(
        err instanceof Error && /permission|denied|allow/i.test(err.message)
          ? "Geen toegang tot de microfoon."
          : "Spraakherkenning is niet beschikbaar.",
      );
    }
  }

  /**
   * Opening the popover is what starts the model downloads — never page load.
   * Idempotent, so reopening costs nothing.
   */
  function toggleSearch() {
    const next = !searchOpen();
    setSearchOpen(next);
    if (next) props.models?.start();
    // Closing drops the candidate list, so reopening never shows results for a
    // query the user has since forgotten about.
    else clearSuggestions();
  }

  return (
    // Nothing renders if both surfaces are disabled — avoids an empty card.
    <Show when={showSearch() || showZoom()}>
      {/* Self-sized card of icon buttons (search, zoom in, zoom out). */}
      <div
        class={`relative flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm ${
          horizontal() ? "flex-row" : "flex-col"
        }`}
      >
        <Show when={showZoom()}>
          <Button variant="ghost" size="icon-sm" onClick={props.onZoomIn} title="Inzoomen">
            <Icon name="add" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={props.onZoomOut} title="Uitzoomen">
            <Icon name="remove" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </Show>
        {/* Search is always the last (rightmost in horizontal / bottom in
            vertical) button so its popover opens into open space to the right. */}
        <Show when={showSearch()}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleSearch}
            title={commandMode() ? "Zoeken of opdracht geven" : "Zoeken"}
          >
            <Icon name="search" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </Show>

        {/* Location search popover. Horizontal (top-left toolbar): expands to the
            right of the search button, aligned with the row. Vertical (bottom-right
            corner): opens to the left of the bottom-most search button, where there
            is room away from the screen edge. */}
        <Show when={showSearch() && searchOpen()}>
          <form
            onSubmit={handleSearch}
            class={`absolute flex flex-col gap-1 rounded-lg bg-white/95 p-1.5 shadow-md backdrop-blur-sm ${
              horizontal() ? "left-full top-0 ml-2" : "right-full bottom-0 mr-2"
            }`}
          >
            <div class="flex items-center gap-1">
            <input
              type="text"
              value={searchQuery()}
              onInput={(e) => {
                setSearchQuery(e.currentTarget.value);
                setMessage(null);
                // Debounced here rather than in an effect, deliberately: this
                // fires only for text the USER typed. Dictation writes the
                // input through setSearchQuery, which raises no input event, so
                // partial speech results cannot each trigger a geocode.
                scheduleSuggestions(e.currentTarget.value);
              }}
              onKeyDown={handleKeyDown}
              role="combobox"
              aria-expanded={suggestions().length > 0}
              aria-controls="map-search-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex() >= 0 ? `map-search-option-${activeIndex()}` : undefined
              }
              placeholder={commandMode() ? "Zoek of geef een opdracht..." : "Zoek een locatie..."}
              class="w-48 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
              // Focused explicitly, not with the `autofocus` attribute: browsers
              // honour that only for an element present in the initial HTML, and
              // this input is created when the popover opens. Deferred a frame
              // so the element is in the document when focus is called.
              ref={(el) => {
                inputRef = el;
                requestAnimationFrame(() => el.focus());
              }}
            />
            {/* Speech input. Present as soon as the project enables it, but
                inert until its model has finished — the greyed state is how the
                user sees that the download is still running. */}
            <Show when={micVisible()}>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                disabled={!micReady()}
                onClick={() => void handleMic()}
                title={
                  !micReady()
                    ? "Spraakherkenning wordt nog geladen..."
                    : listening()
                      ? "Stoppen met luisteren"
                      : "Inspreken"
                }
                aria-label={
                  !micReady()
                    ? "Spraakherkenning wordt nog geladen"
                    : listening()
                      ? "Stoppen met luisteren"
                      : "Inspreken"
                }
                aria-pressed={listening()}
              >
                {/* Red while live, so it is unmistakable that the microphone is
                    open; grey until the model is ready; accent otherwise. */}
                <Icon
                  name="mic"
                  size={chromeIconSize()}
                  color={micReady() && !listening() ? chromeIconColor() : undefined}
                  class={
                    !micReady()
                      ? "text-gray-300"
                      : listening()
                        ? "animate-pulse text-red-600"
                        : undefined
                  }
                />
              </Button>
            </Show>
            <Button variant="ghost" size="icon-sm" type="submit" title="Zoeken">
              {/* Grey until there is something to search for, then the project
                  accent. `hasQuery` is the same trimmed test `handleSearch`
                  refuses on, so the colour states what the button will actually
                  do rather than tracking a second notion of "empty". Passing
                  `color: undefined` leaves the Tailwind class to tint it. */}
              <Icon
                name="send"
                size={chromeIconSize()}
                color={hasQuery() ? chromeIconColor() : undefined}
                class={hasQuery() ? undefined : "text-gray-400"}
              />
            </Button>
            </div>

            {/* Place candidates for what is typed so far. An ambiguous name —
                "Bergen" is three different gemeenten — is picked from here
                rather than guessed at. */}
            <Show when={suggestions().length > 0}>
              <ul
                id="map-search-suggestions"
                role="listbox"
                class="max-h-56 w-48 overflow-y-auto rounded border border-gray-200 bg-white py-0.5"
              >
                <For each={suggestions()}>
                  {(item, index) => (
                    <li
                      id={`map-search-option-${index()}`}
                      role="option"
                      aria-selected={index() === activeIndex()}
                      // mousedown, not click: click fires after blur, and the
                      // blur would tear this list down before the pick landed.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(item);
                      }}
                      onMouseEnter={() => setActiveIndex(index())}
                      class={`cursor-pointer px-2 py-1 text-sm ${
                        index() === activeIndex() ? "bg-blue-50" : ""
                      }`}
                    >
                      <span class="block truncate">{item.label}</span>
                      <Show when={item.kind}>
                        <span class="block truncate text-xs text-gray-500">{item.kind}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            {/* Why a command could not be carried out. Only ever rendered when
                there is something to say, so the popover keeps its height in
                the ordinary case. */}
            <Show when={message()}>
              {(text) => (
                <p class="max-w-[16rem] px-1 text-xs text-gray-600">{text()}</p>
              )}
            </Show>
          </form>
        </Show>
      </div>
    </Show>
  );
}
