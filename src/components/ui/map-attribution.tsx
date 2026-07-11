import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

/**
 * Replacement for MapLibre's default attribution control (disabled in
 * MapView): an app-styled info toolbutton, bottom right. Clicking it opens a
 * small card with the map attribution; for now that is its only content.
 */
export function MapAttribution() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-end gap-2">
      {open && (
        <div className="max-w-64 rounded-xl bg-white/95 p-3 text-xs text-gray-600 shadow-md backdrop-blur-sm">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Kaartgegevens
          </h3>
          <ul className="flex flex-col gap-0.5">
            <li>
              <a
                href="https://maplibre.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                MapLibre
              </a>
            </li>
            <li>
              <a
                href="https://carto.com/attributions"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                © CARTO
              </a>
            </li>
            <li>
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                © OpenStreetMap contributors
              </a>
            </li>
            <li>
              <a
                href="https://www.pdok.nl/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                © PDOK (luchtfoto)
              </a>
            </li>
          </ul>
        </div>
      )}
      <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen((v) => !v)}
          title="Kaartinformatie"
          aria-label="Kaartinformatie"
          aria-expanded={open}
        >
          <Icon name="info" size={chromeIconSize()} color={chromeIconColor()} />
        </Button>
      </div>
    </div>
  );
}
