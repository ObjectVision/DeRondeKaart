import { For, Match, Switch, createSignal, type JSX } from "solid-js";
import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";

/** Map data / imagery credits — attribution required by the providers. */
const DATA_CREDITS = [
  { label: "© OpenFreeMap", href: "https://openfreemap.org/" },
  { label: "© OpenMapTiles", href: "https://openmaptiles.org/" },
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
  { label: "SolidJS", license: "MIT", href: "https://www.solidjs.com/" },
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
  { label: "Geist (font)", license: "OFL-1.1", href: "https://vercel.com/font" },
  {
    label: "Material Symbols",
    license: "Apache-2.0",
    href: "https://fonts.google.com/icons",
  },
  { label: "Maptiler basic style", license: "BSD-3", href: "https://github.com/openmaptiles/maptiler-basic-gl-style/blob/master/LICENSE.md" }
];

/**
 * Replacement for MapLibre's default attribution control (disabled in
 * MapView): an app-styled info toolbutton, bottom right. Clicking it opens a
 * centered modal with the map data attribution and open source software
 * credits.
 *
 * The same shell and width as LayerMetaDialog and BasemapDialog: these are the
 * app's "chrome" windows and are meant to read as one family. The credits are
 * a wall of small print, so the corner card they used to live in was the wrong
 * shape for them.
 */
/** The dialog's tabs, left to right. "Handleiding" is the one it opens on. */
const TABS = [
  { id: "handleiding", label: "Handleiding" },
  { id: "attributie", label: "Attributie" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function MapAttribution(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal<TabId>("handleiding");

  return (
    <div class="flex flex-col items-end gap-2">
      <DialogRoot open={open()} onOpenChange={setOpen}>
        {/* Same width as the other chrome dialogs. DialogContent owns the
            `overflow-y-auto`, so `app-scrollbar` lands here to match the
            navigation and legend cards' scrollbar. */}
        <DialogContent class="app-scrollbar w-[min(40rem,calc(100vw-2rem))] text-sm text-gray-600">
          <div class="mb-5 flex items-center justify-between gap-2">
            {/* Mark and title travel together on the left, so `justify-between`
                keeps only the close button pushed to the right. */}
            <div class="flex items-center gap-2">
              {/* The app mark, from public/favicon.svg — the same file the
                  browser tab uses, so there is one source of truth for it.
                  Decorative: the title beside it already names the app. */}
              <img
                src="/favicon.svg"
                alt=""
                aria-hidden
                draggable={false}
                class="h-6 w-6 shrink-0"
              />
              {/* Same heading treatment as the metainfo and "Referentielagen"
                  dialogs. */}
              <DialogTitle class="text-xs font-semibold uppercase tracking-wide text-gray-500">
                De Ronde kaart
              </DialogTitle>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              title="Sluiten"
              aria-label="Sluiten"
            >
              <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
          </div>

          {/* Tab strip. The labels carry the same type spec as the title above
              them — `text-xs font-semibold uppercase tracking-wide` — so the
              window's two rows of chrome read as one; only color and the
              underline mark which tab is active. The negative margin lets the
              rule run the full width of the window instead of stopping at the
              dialog's own padding. */}
          <div class="-mx-6 mb-5 flex gap-0 border-b border-gray-200 px-6">
            <For each={TABS}>
              {(t) => {
                const isActive = () => t.id === tab();
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive()}
                    onClick={() => setTab(t.id)}
                    class={`px-2 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                      isActive()
                        ? "border-b-2 border-blue-500 text-blue-600"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              }}
            </For>
          </div>

          <Switch>
            {/* Deliberately empty: the manual has not been written yet. The
                min-height holds the window at a stable size rather than letting
                it collapse to just the tab strip. */}
            <Match when={tab() === "handleiding"}>
              <div class="min-h-40" />
            </Match>

            <Match when={tab() === "attributie"}>
              <p class="mb-5 leading-relaxed">
                De Ronde kaart is het startpunt van gesprek, maakt het mogelijk
                ruimtelijke vraagstukken op inzichtelijke wijze samen aan te
                vliegen en te delen.
              </p>
              <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Kaartgegevens
              </h3>
              <ul class="flex flex-col gap-0.5">
                <For each={DATA_CREDITS}>
                  {(c) => (
                    <li>
                      <a
                        href={c.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="hover:underline"
                      >
                        {c.label}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
              <h3 class="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Open source-software
              </h3>
              {/* Two columns at this width: the list is long and each entry is
                  short, so one column per line would leave most of the row
                  empty. */}
              <ul class="grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs leading-relaxed sm:grid-cols-2">
                <For each={SOFTWARE_CREDITS}>
                  {(c) => (
                    <li>
                      <a
                        href={c.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="hover:underline"
                      >
                        {c.label}
                      </a>{" "}
                      <span class="text-gray-400">({c.license})</span>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
          </Switch>
        </DialogContent>
      </DialogRoot>
      <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen((v) => !v)}
          title="Kaartinformatie"
          aria-label="Kaartinformatie"
          aria-expanded={open()}
        >
          <Icon name="info" size={chromeIconSize()} color={chromeIconColor()} />
        </Button>
      </div>
    </div>
  );
}
