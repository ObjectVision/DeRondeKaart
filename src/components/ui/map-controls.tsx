import { Show, createSignal, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor, searchCountries } from "@/config/map-config";

interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
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

  async function handleSearch(e: Event) {
    e.preventDefault();
    if (!searchQuery().trim()) return;

    try {
      const params = new URLSearchParams({
        q: searchQuery(),
        format: "json",
        limit: "1",
      });
      // Restrict to the configured countries, when a project names any. Only
      // the FIRST result is used, so an unrestricted search has no list for the
      // user to correct from: "Bergen" answers with Bergen in Norway, though it
      // is also a town in Noord-Holland and another in Limburg.
      const countries = searchCountries();
      if (countries.length > 0) params.set("countrycodes", countries.join(","));

      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      const results = await res.json();
      if (results.length > 0) {
        const { lat, lon } = results[0];
        // Dispatch a custom event that MapView can listen to
        window.dispatchEvent(
          new CustomEvent("map:flyto", {
            detail: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
          }),
        );
      }
    } catch (err) {
      console.error("Search failed:", err);
    }
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
            onClick={() => setSearchOpen((v) => !v)}
            title="Zoeken"
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
            class={`absolute flex gap-1 rounded-lg bg-white/95 p-1.5 shadow-md backdrop-blur-sm ${
              horizontal() ? "left-full top-0 ml-2" : "right-full bottom-0 mr-2"
            }`}
          >
            <input
              type="text"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder="Zoek een locatie..."
              class="w-48 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
              // Focused explicitly, not with the `autofocus` attribute: browsers
              // honour that only for an element present in the initial HTML, and
              // this input is created when the popover opens. Deferred a frame
              // so the element is in the document when focus is called.
              ref={(el) => requestAnimationFrame(() => el.focus())}
            />
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
          </form>
        </Show>
      </div>
    </Show>
  );
}
