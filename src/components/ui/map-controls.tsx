import { Show, createSignal, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { SearchDialog } from "@/components/ui/SearchDialog";
import { chromeIconSize, chromeIconColor, textToToolEnabled } from "@/config/map-config";
import type { ModelLoader } from "@/ai/model-loader";
import type { GeocodeResult } from "@/tools/geocode/types";

interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /**
   * Run one command line. Resolves to a Dutch message when it could not be
   * carried out, so the search window can say why. Falls back to a location
   * search internally, so this is safe to call before any model has loaded.
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
   * Ranked place candidates for the typed text, for the suggestion list.
   *
   * Optional: without it the window is exactly the submit-only search it was, so
   * a caller that wants no dropdown simply omits it.
   */
  onSuggest?: (query: string, signal: AbortSignal) => Promise<GeocodeResult[]>;
  /** Fly the map to the candidate the user picked. */
  onPick?: (result: GeocodeResult) => void;
  /**
   * "vertical" (default) stacks the buttons (top-mode / right-edge usage);
   * "horizontal" lays them out as a row for the sidebar toolbar. Search is
   * always the last button.
   */
  orientation?: "vertical" | "horizontal";
  /** Show the location-search button (+ its window). Defaults to `true`. */
  showSearch?: boolean;
  /** Show the zoom in/out buttons. Defaults to `true`. */
  showZoom?: boolean;
}

/**
 * The floating map-control card: zoom in/out and the search button.
 *
 * Search itself lives in {@link SearchDialog}, a modal in the same family as
 * "Referentielagen" and the layer metainfo window. This component owns only the
 * button and whether the window is open — which is why the two mounted
 * instances (corner card and sidebar toolbar) can each raise the same dialog
 * without sharing any search state.
 */
export function MapControls(props: MapControlsProps): JSX.Element {
  const [searchOpen, setSearchOpen] = createSignal(false);

  const showSearch = () => props.showSearch ?? true;
  const showZoom = () => props.showZoom ?? true;
  const horizontal = () => (props.orientation ?? "vertical") === "horizontal";

  /**
   * Whether this is a command bar at all, for the button's tooltip. The window
   * decides the same thing again for its own heading and placeholder.
   */
  const commandMode = () => textToToolEnabled() && Boolean(props.onCommand);

  /**
   * Opening the window is what starts the model downloads — never page load.
   * Idempotent, so reopening costs nothing.
   */
  function openSearch() {
    setSearchOpen(true);
    props.models?.start();
  }

  return (
    // Nothing renders if both surfaces are disabled — avoids an empty card.
    <Show when={showSearch() || showZoom()}>
      {/* Self-sized card of icon buttons (zoom in, zoom out, search). */}
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
        <Show when={showSearch()}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={openSearch}
            title={commandMode() ? "Zoeken of opdracht geven" : "Zoeken"}
          >
            <Icon name="search" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </Show>
      </div>

      <Show when={showSearch()}>
        <SearchDialog
          open={searchOpen()}
          onOpenChange={setSearchOpen}
          onCommand={props.onCommand}
          models={props.models}
          onDictate={props.onDictate}
          onStopDictation={props.onStopDictation}
          onSuggest={props.onSuggest}
          onPick={props.onPick}
        />
      </Show>
    </Show>
  );
}
