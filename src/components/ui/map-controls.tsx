import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";

interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function MapControls({ onZoomIn, onZoomOut }: MapControlsProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

  return (
    // Self-sized card of stacked icon buttons (search, zoom in, zoom out).
    <div className="relative flex flex-shrink-0 flex-col gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setSearchOpen((v) => !v)}
        title="Search"
      >
        <Icon name="search" size={18} className="text-[#00498D]" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onZoomIn}
        title="Inzoomen"
      >
        <Icon name="add" size={18} className="text-[#00498D]" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onZoomOut}
        title="Uitzoomen"
      >
        <Icon name="remove" size={18} className="text-[#00498D]" />
      </Button>

      {/* Location search popover — opens to the left of the magnifying glass. */}
      {searchOpen && (
        <form
          onSubmit={handleSearch}
          className="absolute right-full top-0 mr-2 flex gap-1 rounded-lg bg-white/95 p-1.5 shadow-md backdrop-blur-sm"
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
            <Icon name="send" size={18} className="text-gray-400" />
          </Button>
        </form>
      )}
    </div>
  );
}
