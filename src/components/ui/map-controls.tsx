import { useState } from "react";
import { Button } from "@/components/ui/button";

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
    <div className="absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2">
      {searchOpen && (
        <form
          onSubmit={handleSearch}
          className="flex gap-1 rounded-lg bg-white/90 p-1.5 shadow-md backdrop-blur-sm"
        >
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search location..."
            className="w-48 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
            autoFocus
          />
          <Button variant="outline" size="xs" type="submit">
            Go
          </Button>
        </form>
      )}
      <div className="flex flex-col gap-1 rounded-lg bg-white/90 p-1 shadow-md backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSearchOpen((v) => !v)}
          title="Search"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
          </svg>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onZoomIn} title="Zoom in">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
          </svg>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onZoomOut} title="Zoom out">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path fillRule="evenodd" d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" clipRule="evenodd" />
          </svg>
        </Button>
      </div>
    </div>
  );
}
