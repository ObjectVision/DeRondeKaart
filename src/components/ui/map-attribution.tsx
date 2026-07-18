import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

/** Map data / imagery credits — attribution required by the providers. */
const DATA_CREDITS = [
  { label: "© CARTO", href: "https://carto.com/attributions" },
  {
    label: "© OpenStreetMap contributors",
    href: "https://www.openstreetmap.org/copyright",
  },
  { label: "© PDOK (luchtfoto)", href: "https://www.pdok.nl/" },
];

/**
 * Open source software credits (license names verified against the installed
 * packages). Their licenses don't require in-UI attribution — the credits are
 * a courtesy; the license texts ship with the application bundle.
 */
const SOFTWARE_CREDITS = [
  { label: "MapLibre GL JS", license: "BSD-3", href: "https://maplibre.org/" },
  { label: "React", license: "MIT", href: "https://react.dev/" },
  {
    label: "react-map-gl",
    license: "MIT",
    href: "https://visgl.github.io/react-map-gl/",
  },
  { label: "deck.gl", license: "MIT", href: "https://deck.gl/" },
  {
    label: "GeoArrow layers",
    license: "MIT",
    href: "https://github.com/geoarrow/deck.gl-geoarrow",
  },
  { label: "Apache Arrow", license: "Apache-2.0", href: "https://arrow.apache.org/" },
  {
    label: "parquet-wasm",
    license: "MIT/Apache-2.0",
    href: "https://github.com/kylebarron/parquet-wasm",
  },
  {
    label: "maplibre-cog-protocol",
    license: "MIT",
    href: "https://github.com/geomatico/maplibre-cog-protocol",
  },
  { label: "Yjs", license: "MIT", href: "https://yjs.dev/" },
  {
    label: "Hocuspocus",
    license: "MIT",
    href: "https://github.com/ueberdosis/hocuspocus",
  },
  { label: "D3", license: "ISC", href: "https://d3js.org/" },
  { label: "Tailwind CSS", license: "MIT", href: "https://tailwindcss.com/" },
  { label: "Base UI", license: "MIT", href: "https://base-ui.com/" },
  { label: "Lucide", license: "ISC", href: "https://lucide.dev/" },
  {
    label: "node-qrcode",
    license: "MIT",
    href: "https://github.com/soldair/node-qrcode",
  },
  { label: "Geist (font)", license: "OFL-1.1", href: "https://vercel.com/font" },
  {
    label: "Material Symbols",
    license: "Apache-2.0",
    href: "https://fonts.google.com/icons",
  },
];

/**
 * Replacement for MapLibre's default attribution control (disabled in
 * MapView): an app-styled info toolbutton, bottom right. Clicking it opens a
 * small card with the map data attribution and open source software credits.
 */
export function MapAttribution() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col items-end gap-2">
      {open && (
        <div className="max-w-72 rounded-xl bg-white/95 p-3 text-xs text-gray-600 shadow-md backdrop-blur-sm">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            De Ronde kaart
          </h3>
          <p className="mb-3 leading-snug">
            De Ronde kaart is het startpunt van gesprek, maakt het mogelijk
            ruimtelijke vraagstukken op inzichtelijke wijze samen aan te
            vliegen en te delen. En is ontwikkeld door Object Vision in
            samenwerking met InnDev en Faire Consultancy.
          </p>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Kaartgegevens
          </h3>
          <ul className="flex flex-col gap-0.5">
            {DATA_CREDITS.map((c) => (
              <li key={c.label}>
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {c.label}
                </a>
              </li>
            ))}
          </ul>
          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Open source-software
          </h3>
          <p className="flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] leading-snug">
            {SOFTWARE_CREDITS.map((c, i) => (
              <span key={c.label} className="whitespace-nowrap">
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {c.label}
                </a>{" "}
                <span className="text-gray-400">({c.license})</span>
                {i < SOFTWARE_CREDITS.length - 1 && (
                  <span className="text-gray-300"> ·</span>
                )}
              </span>
            ))}
          </p>
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
