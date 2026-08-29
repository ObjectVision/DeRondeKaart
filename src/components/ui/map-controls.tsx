import { Show, createSignal, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import {
  chromeIconSize,
  chromeIconColor,
  speechToTextEnabled,
  textToToolEnabled,
} from "@/config/map-config";
import type { ModelLoader } from "@/ai/model-loader";

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
    try {
      const failure = await props.onCommand?.(text);
      setMessage(failure ?? null);
    } finally {
      setBusy(false);
    }
  }

  /** True while the microphone is live. */
  const [listening, setListening] = createSignal(false);

  /**
   * Dictate one utterance, then submit it as a command.
   *
   * A second click stops without submitting, which is the way out if the
   * recogniser never hears an end-of-speech pause.
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
      const spoken = await props.onDictate?.((partial) => setSearchQuery(partial));
      setListening(false);
      if (!spoken?.trim()) return;

      setSearchQuery(spoken);
      setBusy(true);
      try {
        setMessage((await props.onCommand?.(spoken)) ?? null);
      } finally {
        setBusy(false);
      }
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
              }}
              placeholder={commandMode() ? "Zoek of geef een opdracht..." : "Zoek een locatie..."}
              class="w-48 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
              // Focused explicitly, not with the `autofocus` attribute: browsers
              // honour that only for an element present in the initial HTML, and
              // this input is created when the popover opens. Deferred a frame
              // so the element is in the document when focus is called.
              ref={(el) => requestAnimationFrame(() => el.focus())}
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
