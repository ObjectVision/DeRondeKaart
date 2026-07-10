import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

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

export function MapControls({
  onZoomIn,
  onZoomOut,
  orientation = "vertical",
  showSearch = true,
  showZoom = true,
}: MapControlsProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Nothing to render if both surfaces are disabled — avoids an empty card.
  if (!showSearch && !showZoom) return null;

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`,
      );
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

  const horizontal = orientation === "horizontal";

  return (
    // Self-sized card of icon buttons (search, zoom in, zoom out).
    <div
      className={`relative flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm ${
        horizontal ? "flex-row" : "flex-col"
      }`}
    >
      {showZoom && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onZoomIn}
            title="Inzoomen"
          >
            <Icon name="add" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onZoomOut}
            title="Uitzoomen"
          >
            <Icon name="remove" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </>
      )}
      {/* Search is always the last (rightmost in horizontal / bottom in
          vertical) button so its popover opens into open space to the right. */}
      {showSearch && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSearchOpen((v) => !v)}
          title="Zoeken"
        >
          <Icon name="search" size={chromeIconSize()} color={chromeIconColor()} />
        </Button>
      )}

      {/* Location search popover. Horizontal (top-left toolbar): expands to the
          right of the search button, aligned with the row. Vertical (bottom-right
          corner): opens to the left of the bottom-most search button, where there
          is room away from the screen edge. */}
      {showSearch && searchOpen && (
        <form
          onSubmit={handleSearch}
          className={`absolute flex gap-1 rounded-lg bg-white/95 p-1.5 shadow-md backdrop-blur-sm ${
            horizontal ? "left-full top-0 ml-2" : "right-full bottom-0 mr-2"
          }`}
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Zoek een locatie..."
            className="w-48 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
            autoFocus
          />
          <Button variant="ghost" size="icon-sm" type="submit" title="Zoeken">
            <Icon name="send" size={chromeIconSize()} className="text-gray-400" />
          </Button>
        </form>
      )}
    </div>
  );
}
