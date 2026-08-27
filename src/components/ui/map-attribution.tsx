import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type JSX,
} from "solid-js";
import { DialogContent, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import { useLocalFlag } from "@/hooks/use-local-flag";
import { cn } from "@/lib/utils";

/** Where this application's own source lives. */
const SOURCE_REPO = "https://github.com/ObjectVision/DeRondeKaart";

/**
 * The comparison-slider animation on the Verschilkaart tab.
 *
 * The file itself is set to play once (its GIF loop count is 1, not the usual
 * 0 = forever): a 1.5s loop running under the text is a distraction, and a
 * browser obeys the file's own loop count — CSS and JS cannot stop an `<img>`
 * mid-loop. Clicking replays it; see `replay` below.
 */
const SLIDER_GIF = "/handleiding_links_rechts.gif";

/**
 * Marks that this browser has been shown the guide. Permanent (localStorage):
 * the first-visit window must not return on the next visit.
 */
const GUIDE_SEEN_KEY = "guide-seen";

/**
 * Marks that this browser has been shown the Verschilkaart tab on entering
 * comparison mode. Kept apart from {@link GUIDE_SEEN_KEY} on purpose: the two
 * record different events, and a project that greets visitors on load would
 * otherwise never get to explain the slider.
 */
const VERSCHILKAART_SEEN_KEY = "verschilkaart-seen";

/**
 * Whether the first-visit guide has already been claimed by an instance in this
 * page load.
 *
 * App renders two `<MapAttribution>`s — one for the top-nav chrome row, one for
 * the sidebar toolbar — and only one is ever *displayed*. But the sidebar's is
 * passed as a `toolbar` JSX prop, which Solid constructs eagerly, so BOTH
 * components run their setup even though one is never shown. Without this latch
 * both auto-open, and the app shows two stacked windows: the top one dimming
 * the page behind it, the one underneath appearing as undimmed content spilling
 * out below the dialog.
 *
 * Module scope is deliberate: the two instances share no ancestor state, and
 * this is a once-per-page-load decision, exactly the lifetime of the module.
 */
let guideClaimed = false;

/**
 * The same claim, for the Verschilkaart trigger.
 *
 * The `verschilkaart-seen` flag alone cannot do this job. `useLocalFlag` seeds
 * a per-instance signal from storage once, at setup, so when one instance
 * writes the flag the twin's signal stays `false` — it never re-reads storage.
 * Both instances then open a window on the same comparison event, and closing
 * the top one reveals the second still sitting underneath.
 *
 * Module scope for the same reason as {@link guideClaimed}: the two instances
 * share no ancestor state, and "has this page load already shown it" is exactly
 * the module's lifetime.
 */
let verschilkaartClaimed = false;

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
/**
 * One explained control in the Handleiding: its own icon, the term in bold, and
 * what it does.
 *
 * `icon` is optional because two entries describe gestures rather than buttons
 * (zooming and panning), and a stand-in glyph there would read as a control
 * that exists. The row keeps its text aligned with the iconned rows either way.
 *
 * NOTE the icon is passed as `children`, not as a name prop. The build-time font
 * subsetter (scripts/subset-icon-font.ts) only finds glyph names written as a
 * literal `name="…"`, so every <Icon> below spells its name out. Threading the
 * name through a prop here would hide all of them from the scan and ship a font
 * without them — which fails as raw text in the built bundle only.
 */
function GuideItem(props: {
  icon?: JSX.Element;
  term: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <li class="flex gap-2">
      {/* Fixed-size box so every label starts on the same left edge, whether or
          not the row has an icon. */}
      <span class="flex h-6 w-6 shrink-0 items-center justify-center">
        {props.icon}
      </span>
      <span class="leading-relaxed">
        <span class="font-semibold text-gray-900">{props.term}</span>: {props.children}
      </span>
    </li>
  );
}

/** A numbered section of the Handleiding, as one card. */
function GuideSection(props: {
  number: number;
  title: string;
  intro?: string;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section
      class={cn(
        "rounded-2xl border border-gray-200 p-4",
        props.class,
      )}
    >
      <h3 class="mb-1 flex items-center gap-2">
        {/* Badge and heading carry the project's chrome color, so a config that
            sets its own chromeIconColor restyles the guide with it. Inline
            styles because that color is a runtime value a class cannot read. */}
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ "background-color": chromeIconColor() }}
        >
          {props.number}
        </span>
        <span
          class="text-base font-semibold"
          style={{ color: chromeIconColor() }}
        >
          {props.title}
        </span>
      </h3>
      <Show when={props.intro}>
        <p class="mb-3 leading-relaxed text-gray-500">{props.intro}</p>
      </Show>
      <ul class="flex flex-col gap-2">{props.children}</ul>
    </section>
  );
}

/** The dialog's tabs, left to right. "Handleiding" is the one it opens on. */
const TABS = [
  { id: "handleiding", label: "Handleiding" },
  { id: "verschilkaart", label: "Verschilkaart" },
  { id: "attributie", label: "Attributie" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface MapAttributionProps {
  /**
   * Open the window by itself on this browser's first visit — `map.json`'s
   * `showGuideOnFirstVisit`. Ignored once the guide has been seen.
   */
  autoOpen?: boolean;
  /**
   * Open the window on its Verschilkaart tab the first time comparison mode
   * turns on — `map.json`'s `showVerschilkaartOnFirstUse`.
   */
  showVerschilkaartOnFirstUse?: boolean;
  /** Whether comparison mode is currently on (both maps under a divider). */
  comparisonActive?: boolean;
}

export function MapAttribution(props: MapAttributionProps): JSX.Element {
  const [seen, setSeen] = useLocalFlag(GUIDE_SEEN_KEY, false);
  const [vkSeen, setVkSeen] = useLocalFlag(VERSCHILKAART_SEEN_KEY, false);
  // Deliberately a one-shot read of both inputs, hence `untrack`: this decides
  // the window's state at mount and nothing more. Tracking them would reopen
  // the window the moment `seen` flips — which happens as the user closes it.
  const [open, setOpen] = createSignal(
    untrack(() => {
      if (!props.autoOpen || seen() || guideClaimed) return false;
      // First instance in this page load wins; the twin stays shut.
      guideClaimed = true;
      onCleanup(() => (guideClaimed = false));
      return true;
    }),
  );
  const [tab, setTab] = createSignal<TabId>("handleiding");
  // Bumped on click to replay the (play-once) animation. The counter becomes a
  // cache-busting query param: re-assigning the SAME url does not restart a
  // finished GIF, since the browser reuses the decoded image in its final
  // state. Starts at 0 so the first render requests the plain, cacheable url.
  const [replay, setReplay] = createSignal(0);
  const sliderGifSrc = () =>
    replay() === 0 ? SLIDER_GIF : `${SLIDER_GIF}?replay=${replay()}`;
  /**
   * Switch tabs and return to the top of the new panel.
   *
   * Without this the window keeps the outgoing panel's scroll offset: leave the
   * tall Handleiding scrolled down, and the short Attributie opens already
   * scrolled past its own heading.
   *
   * The scroller is found from the clicked tab rather than held in a ref:
   * DialogContent owns `overflow-y-auto` on its own element and exposes no ref
   * (its inner one is spoken for by the focus trap), and widening that shared
   * component's API for this one caller would be the larger change.
   */
  function selectTab(next: TabId, from: HTMLElement) {
    setTab(next);
    // `scrollTop` rather than `scrollTo`: it is a plain property, so it works
    // in jsdom too, where `Element.scrollTo` is not implemented and throws.
    const win = from.closest('[role="dialog"]');
    if (win) win.scrollTop = 0;
  }

  // Whether THIS instance took the Verschilkaart claim. Released on unmount
  // only (below), so a remount can show the window again — and guarded on this
  // flag, so unmounting the twin cannot free a claim it never held.
  let claimedHere = false;
  onCleanup(() => {
    if (claimedHere) verschilkaartClaimed = false;
  });

  /**
   * Explain the comparison slider the first time the user actually enters
   * comparison mode, opening the window on the Verschilkaart tab.
   *
   * Every reactive input is read BEFORE any early return. An effect subscribes
   * only to what its last run actually read, and `comparisonActive` is false on
   * the run that happens at mount — bail out before reading it and the effect
   * unsubscribes from the one signal it exists to watch, then never fires
   * again. That failure is silent: no error, nothing in the tests unless one
   * flips comparison on after mount.
   *
   * This also runs in BOTH instances App renders (the sidebar's arrives as an
   * eagerly-constructed JSX prop), so it needs a guard against opening twice.
   * That guard is {@link verschilkaartClaimed}, NOT the stored `vkSeen` flag:
   * `useLocalFlag` seeds a per-instance signal from storage once at setup, so
   * one instance writing the flag leaves the twin's signal untouched and both
   * open. The two work together — the latch prevents a double window within a
   * page load, the stored flag remembers across them.
   */
  createEffect(() => {
    const active = props.comparisonActive;
    const enabled = props.showVerschilkaartOnFirstUse;
    const already = vkSeen();
    if (!active || !enabled || already || verschilkaartClaimed) return;

    // Claim before opening, so the twin instance reacting to the same signal
    // change finds it taken. The stored flag is the memory across page loads;
    // this latch is what keeps the two instances from both opening within one.
    //
    // The claim is released on unmount only (see the component-scope onCleanup
    // below), NOT here: an onCleanup registered inside an effect runs before
    // every re-run of that effect, so releasing it here would hand the claim
    // back the next time comparison state changed — the twin would then open a
    // second window behind the first, and the X would need two clicks.
    verschilkaartClaimed = true;
    claimedHere = true;
    setVkSeen(true);
    setTab("verschilkaart");
    // A no-op when the window is already up (the first-visit guide, say), which
    // is what keeps this from ever stacking a second dialog: that window simply
    // moves to the tab describing what just appeared on the map.
    setOpen(true);
    // The tab is set programmatically here, bypassing `selectTab`, so reset the
    // scroll by hand — an already-open window may be scrolled down.
    queueMicrotask(() => {
      const win = document.querySelector('[role="dialog"]');
      if (win) win.scrollTop = 0;
    });
  });

  /**
   * Every close routes through here, so none can skip recording the visit:
   * DialogRoot funnels the backdrop click and Escape into `onOpenChange` too.
   *
   * Any close counts, not just an auto-opened one — someone who opened the
   * guide from the toolbutton has read it just the same.
   */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSeen(true);
  }

  // A fragment, not a positioning wrapper: this sits in the chrome toolbar row
  // beside the share button, so laying itself out is the caller's job. The
  // dialog is portalled and contributes nothing here; only the trigger pill
  // below takes space.
  return (
    <>
      <DialogRoot open={open()} onOpenChange={handleOpenChange}>
        {/* Wider than the other chrome dialogs: the Handleiding lays its three
            sections out two-up, which needs the room. 64rem is the dialog
            shell's own default width, not a new number. DialogContent owns the
            `overflow-y-auto`, so `app-scrollbar` lands here to match the
            navigation and legend cards' scrollbar. */}
        {/* Pinned to a fixed top rather than vertically centred, as
            LayerMetaDialog is: the tabs differ a lot in height, and a centred
            window jumps as they switch. Height still follows the content, so
            the short Attributie tab stays a short window. */}
        <DialogContent class="app-scrollbar top-[6vh] max-h-[calc(94vh-1rem)] w-[min(64rem,calc(100vw-2rem))] translate-y-0 text-sm text-gray-600">
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
              onClick={() => handleOpenChange(false)}
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
                    onClick={(e) => selectTab(t.id, e.currentTarget)}
                    // The underline is always laid out, transparent when the tab
                    // is inactive, so switching tabs recolors it instead of
                    // adding a border that nudges the labels up by 2px.
                    class={`border-b-2 border-transparent px-2 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                      isActive() ? "" : "text-gray-500 hover:text-gray-700"
                    }`}
                    // The active tab takes the project's chrome color, like the
                    // guide's badges and headings. Inline because that color is a
                    // runtime value no Tailwind class can carry.
                    style={
                      isActive()
                        ? {
                            color: chromeIconColor(),
                            "border-bottom-color": chromeIconColor(),
                          }
                        : undefined
                    }
                  >
                    {t.label}
                  </button>
                );
              }}
            </For>
          </div>

          <Switch>
            <Match when={tab() === "handleiding"}>
              {/* Two-up on wide screens, stacked below; section 3 spans both
                  columns since its own items sit two-up inside it. */}
              <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <GuideSection
                  number={1}
                  title="Thema's en kaartlagen"
                  intro="Vind kaartlagen op basis van thema's en subthema's en toon ze in kaart en legenda."
                >
                  <GuideItem
                    icon={<Icon name="expand_more" size={20} color={chromeIconColor()} />}
                    term="Openen"
                  >
                    klik op een thema voor de subthema's en kaartlagen.
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="check_circle" size={20} color={chromeIconColor()} />}
                    term="Kaartlaag tonen"
                  >
                    klik het rondje achter de laagnaam om de laag in kaart en legenda
                    te tonen; nogmaals klikken zet de laag weer uit.
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="remove" size={20} color={chromeIconColor()} />}
                    term="Verbergen"
                  >
                    verberg de thema-dialoog met deze knop rechts naast het label:
                    THEMAS (staat default aan, behalve op mobiel).
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="layers" size={20} color={chromeIconColor()} />}
                    term="Tonen"
                  >
                    zet de thema-dialoog (weer) aan met de knop linksboven in het scherm.
                  </GuideItem>
                </GuideSection>

                <GuideSection
                  number={2}
                  title="Legenda"
                  intro="Toont actieve lagen, in tekenvolgorde, met kleuren, symbolen en klassegrenzen."
                >
                  <GuideItem
                    icon={<Icon name="map" size={20} color={chromeIconColor()} />}
                    term="Referentielagen"
                  >
                    kies een achtergrond (luchtfoto/kleur/grijs) en zet labels/wegen
                    als voorgrond aan of uit.
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="more_vert" size={20} color={chromeIconColor()} />}
                    term="Opties per laag"
                  >
                    toon of verberg de laagopties:
                  </GuideItem>
                  {/* The four per-layer options, indented behind a rule to show
                      they live under "Opties per laag" above. */}
                  <li>
                    <ul class="ml-3 flex flex-col gap-2 border-l border-gray-200 pl-3">
                      <GuideItem
                        icon={<Icon name="opacity" size={20} color={chromeIconColor()} />}
                        term="Transparantie"
                      >
                        teken de laag met 50% transparantie; nogmaals klikken terug
                        naar 100%.
                      </GuideItem>
                      <GuideItem
                        icon={<Icon name="info" size={20} color={chromeIconColor()} />}
                        term="Informatie"
                      >
                        vraag aanvullende info over de laag op.
                      </GuideItem>
                      <GuideItem
                        icon={<Icon name="close" size={20} color={chromeIconColor()} />}
                        term="Verwijder"
                      >
                        verwijder de kaartlaag uit de kaart.
                      </GuideItem>
                      <GuideItem
                        icon={
                          <Icon
                            name="arrow_circle_right"
                            size={20}
                            color={chromeIconColor()}
                          />
                        }
                        term="Tweede kaart"
                      >
                        verplaats de laag naar de rechterkaart; terugzetten kan met
                        de pijl-links knop.
                      </GuideItem>
                    </ul>
                  </li>
                  <GuideItem
                    icon={<Icon name="drag_indicator" size={20} color={chromeIconColor()} />}
                    term="Volgorde"
                  >
                    sleep de laag omhoog/omlaag om de tekenvolgorde aan te passen.
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="remove" size={20} color={chromeIconColor()} />}
                    term="Verbergen"
                  >
                    verberg de legenda met deze knop rechts naast het label LEGENDA
                    (staat default aan, behalve op mobiel)
                  </GuideItem>
                  <GuideItem
                    icon={<Icon name="legend_toggle" size={20} color={chromeIconColor()} />}
                    term="Tonen"
                  >
                    zet de legenda (weer) aan met de knop linksonder in het scherm.
                  </GuideItem>
                </GuideSection>

                <GuideSection
                  number={3}
                  title="Navigeren en informatie opvragen"
                  class="lg:col-span-2"
                >
                  {/* Two-up inside the full-width card, as in the other sections. */}
                  <li class="contents">
                    <ul class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                      {/* No icon: this one is a mouse gesture, not a button. */}
                      <GuideItem term="In-/uitzoomen en pannen">
                        zoom met muis/scrollwiel, versleep de kaart naar het gewenste
                        gebied.
                      </GuideItem>
                      <GuideItem
                        icon={<Icon name="search" size={20} color={chromeIconColor()} />}
                        term="Zoeken"
                      >
                        zoek op gemeente, wijk, buurt of straat en zoom er direct
                        naartoe.
                      </GuideItem>
                      <GuideItem
                        icon={<Icon name="share" size={20} color={chromeIconColor()} />}
                        term="Delen"
                      >
                        deel de kaart of download deze als afbeelding.
                      </GuideItem>
                      <GuideItem
                        icon={<Icon name="ads_click" size={20} color={chromeIconColor()} />}
                        term="Klik op de kaart"
                      >
                        bekijk de beschikbare informatie over de locatie.
                      </GuideItem>
                    </ul>
                  </li>
                </GuideSection>
              </div>
            </Match>

            <Match when={tab() === "verschilkaart"}>
              {/* One sentence and the animation, centred on the same column
                  width as the image below it: the tab has a single idea to
                  explain, and the guide's numbered-section cards would be
                  scaffolding around one paragraph. */}
              <div class="mx-auto flex max-w-[500px] flex-col gap-3">
                <p class="leading-relaxed">
                  Met de verticale schuif of het handvat{" "}
                  {/* The handle's own glyph, inline in the sentence and in the
                      project's chrome size/color, so the text points at exactly
                      what the user sees on the map. Spelled as a literal
                      name="…" — the build-time font subsetter scans for that
                      form, and a missed name ships as raw text. */}
                  <span class="inline-flex translate-y-[0.15em] align-middle">
                    <Icon
                      name="arrows_outward"
                      size={chromeIconSize()}
                      color={chromeIconColor()}
                    />
                  </span>{" "}
                  in het midden kunnen verschillen tussen kaartlagen eenvoudig in
                  beeld worden gebracht.
                </p>
                {/* Plays once, then holds its last frame; click (or Enter/Space)
                    to play it again. Interactive, so it carries a button role
                    and a key handler rather than a bare onClick. */}
                <img
                  src={sliderGifSrc()}
                  alt="Animatie: de verticale schuif wordt naar links en rechts gesleept om twee kaartlagen te vergelijken."
                  title="Klik om opnieuw af te spelen"
                  role="button"
                  tabIndex={0}
                  draggable={false}
                  onClick={() => setReplay((n) => n + 1)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    setReplay((n) => n + 1);
                  }}
                  // Capped at the file's own 500px so it is never upscaled into
                  // a soft image; w-full lets it shrink on a narrow window.
                  class="h-auto w-full max-w-[500px] cursor-pointer rounded-xl ring-1 ring-gray-200"
                />
              </div>
            </Match>

            <Match when={tab() === "attributie"}>
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
              <h3 class="mb-1 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Broncode
              </h3>
              <p class="text-xs leading-relaxed">
                <a
                  href={SOURCE_REPO}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hover:underline"
                >
                  {/* The bare URL, not a friendly label: it doubles as the
                      address to type when the link cannot be clicked. */}
                  {SOURCE_REPO}
                </a>
              </p>
            </Match>
          </Switch>
        </DialogContent>
      </DialogRoot>
      <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => handleOpenChange(!open())}
          title="Over de applicatie"
          aria-label="Over de applicatie"
          aria-expanded={open()}
        >
          <Icon name="help" size={chromeIconSize()} color={chromeIconColor()} />
        </Button>
      </div>
    </>
  );
}
