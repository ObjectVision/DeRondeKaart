import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";

/**
 * Our own copies of PBL's viewer, one per model year; see
 * public/pbl-samenvatting.html for why they exist and what they mirror.
 *
 * One page per year rather than one page with a `?year=`: each is a mirror of a
 * different external document, and has to match that document's own `<body>`
 * markup and script list.
 */
const PBL_PAGE_2024 = "/pbl-samenvatting.html";
const PBL_PAGE_2026 = "/pbl-samenvatting-2026.html";

/**
 * The file whose presence proves PBL has published a model year's DATA, not
 * just its code.
 *
 * The gemeente table specifically, because it is the first thing their bundle
 * loads and the one whose absence is visible: the viewer fills its gemeente
 * dropdown from it, and without it the page offers nothing to select — by us or
 * by hand.
 *
 * This is not hypothetical. PBL published the 2026 viewer's scripts and
 * stylesheets while its entire `assets/data/` tree 404s, so their own page is
 * as empty as our mirror of it. See {@link pblYearPublished}.
 */
const PBL_DATA_BASE = "https://infographics.pbl.nl/startanalyse";
const PBL_DATA_2024 = `${PBL_DATA_BASE}/2024/samenvatting/assets/data/csv/gemeenten_2024.csv`;
const PBL_DATA_2026 = `${PBL_DATA_BASE}/2026/samenvatting/assets/data/csv/gemeenten_2026.csv`;

/** One tab of the summary: a model year the viewer can be shown for. */
export interface PblSummaryTab {
  /** Stable id for the tab strip. */
  id: string;
  /** What the tab is called, e.g. "ASA2026". */
  label: string;
  /** The mirror page for that PBL year. */
  page: string;
  /** PBL file that exists only once this year's data is published. */
  dataUrl: string;
}

const ASA2025: PblSummaryTab = {
  id: "asa2025",
  label: "ASA2025",
  page: PBL_PAGE_2024,
  dataUrl: PBL_DATA_2024,
};
const ASA2026: PblSummaryTab = {
  id: "asa2026",
  label: "ASA2026",
  page: PBL_PAGE_2026,
  dataUrl: PBL_DATA_2026,
};

/**
 * The summary tabs for a config variant, in the order they are shown. One entry
 * means the caller renders no tab strip.
 *
 * **The mapping is deliberately skewed: config variant `2025` shows PBL model
 * year 2024.** That is not an off-by-one — the Startanalyse edition a variant
 * carries and the year PBL publishes its viewer under are simply numbered
 * differently, and `2026` does line up. Renaming either side to match would
 * break the other.
 *
 * The comparison variant offers both, and the caller opens on ASA2026: the
 * newer edition is the one being evaluated, with the older there to compare
 * against.
 *
 * An unknown variant — including `null`, which is every project that declares
 * no variants at all — falls back to the 2024 page, so nothing changes for a
 * config that never asked for this.
 */
export function pblSummaryTabs(variant: string | null): PblSummaryTab[] {
  if (variant === "2026") return [ASA2026];
  if (variant === "2025_2026") return [ASA2025, ASA2026];
  return [ASA2025];
}

/**
 * The tab a variant opens on: the LAST one, which is the newest edition
 * offered. Derived rather than flagged, so a tab list and its default cannot
 * disagree.
 */
export function defaultPblSummaryTab(tabs: PblSummaryTab[]): PblSummaryTab {
  return tabs[tabs.length - 1];
}

/**
 * Resolved probes, keyed by URL. Keyed by URL and NOT by layer id, so it is
 * deliberately not registered with `registerVariantScopedCache`: the answer is
 * a property of PBL's server, not of the active config variant, and clearing it
 * on every variant switch would re-ask for nothing.
 */
const publishedCache = new Map<string, Promise<boolean>>();

/** Test seam: drop the memoised probes. */
export function clearPblPublishedCache(): void {
  publishedCache.clear();
}

/**
 * Whether PBL has published the DATA for a model year, by asking for the one
 * file named in {@link PblSummaryTab.dataUrl}.
 *
 * **Fails open.** Only 404 and 410 — the server positively saying the file is
 * not there — count as unpublished. A thrown fetch (offline, DNS, CORS) or any
 * other status (403, 405, 5xx) resolves true, because "we could not ask" must
 * never hide a viewer that works. Getting this backwards would blank the 2024
 * summary on a flaky connection, which is far worse than briefly showing an
 * empty 2026 one.
 *
 * HEAD rather than GET: the gemeente table is a real download and nothing here
 * reads its body. PBL answers HEAD with `access-control-allow-origin: *`.
 */
export function pblYearPublished(dataUrl: string): Promise<boolean> {
  const cached = publishedCache.get(dataUrl);
  if (cached) return cached;

  const probe = fetch(dataUrl, { method: "HEAD" })
    .then((response) => !(response.status === 404 || response.status === 410))
    .catch(() => true);
  publishedCache.set(dataUrl, probe);
  return probe;
}

/**
 * The probe's answer for the active tab: null while it is in flight, then true
 * or false.
 *
 * Call inside a reactive owner. Switching tabs re-probes, and a resolution that
 * arrives after the tab moved on is dropped — otherwise the old year's verdict
 * would land on the new year's frame, which is exactly the kind of failure that
 * shows up as a correct-looking page with the wrong content behind it.
 */
export function createPblYearAvailability(
  dataUrl: Accessor<string>,
): Accessor<boolean | null> {
  const [available, setAvailable] = createSignal<boolean | null>(null);

  createEffect(() => {
    // Read before anything can return early, so the effect stays subscribed.
    const url = dataUrl();
    setAvailable(null);

    let current = true;
    onCleanup(() => {
      current = false;
    });

    void pblYearPublished(url).then((published) => {
      if (current) setAvailable(published);
    });
  });

  return available;
}

/**
 * A CBS neighbourhood code: "BU" followed by a 4-digit gemeente and a 4-character
 * buurt. The viewer derives the gemeente from it, so the digits of that half are
 * load-bearing and checked rather than assumed.
 *
 * The buurt half is alphanumeric, not numeric: Amsterdam's are letter-led
 * throughout (BU0363FF03 is Bedrijvenpark Lutkemeer). Requiring digits there
 * rejected all 517 of its neighbourhoods.
 */
const BU_CODE_RE = /^BU\d{4}[0-9A-Z]{4}$/;

/** A picked feature, as carried in FeatureInfoResult.featuresByLayer. */
interface PickedFeature {
  properties: Record<string, unknown>;
}

/**
 * The CBS code of the neighbourhood a feature identifies, or null when it has
 * none. `bu_code` comes straight from the vector tiles, which every buurt-level
 * archive in this project publishes.
 *
 * Only the buurt code is needed: the gemeente is encoded in its digits. Note the
 * tiles' `gemeentenaam` is NOT the gemeente — on BU19040213 it reads "Breukelen
 * Zuid" (the buurt) while the gemeente is Stichtse Vecht — so it must not be
 * used to identify one.
 */
export function buurtCodeOf(feature: PickedFeature | undefined): string | null {
  if (!feature) return null;
  const code = feature.properties.bu_code;
  if (typeof code !== "string" || !BU_CODE_RE.test(code)) return null;
  return code;
}

/**
 * URL of a local PBL viewer page for one neighbourhood. The page is ours and
 * only loads PBL's assets; it reads this parameter to drive their selection
 * flow.
 *
 * `page` comes from {@link pblSummaryTabs}, so the model year shown follows the
 * active config variant.
 */
export function pblSummaryUrl(buurtCode: string, page: string): string {
  const params = new URLSearchParams({ bu: buurtCode });
  return `${page}?${params.toString()}`;
}

/**
 * How long the parent waits for the frame's verdict before uncovering it
 * anyway.
 *
 * public/pbl-buurt-select.js reports every terminal outcome, so this is only
 * reached when the frame never gets that far — a script that failed to parse,
 * an assets host that hangs rather than errors. Its own deadline is 60s per
 * `waitFor` and two run in sequence, so waiting for that would mean up to two
 * minutes of logo. Better to show PBL's page, whatever state it reached.
 *
 * The same reasoning as dismissSplash() in lib/splash.ts: the timeout, not the
 * event, is what guarantees the splash comes down.
 */
export const PBL_SUMMARY_TIMEOUT_MS = 20000;

/** What the framed viewer reports back once it stops trying. */
export type PblSummaryStatus = "loading" | "ready" | "failed";

/**
 * Read a `message` event as a verdict from the framed viewer, or null when it is
 * not one.
 *
 * The origin check is the point: this window also receives postMessage traffic
 * from an embedding host (see use-url-commands.ts), and the frame is same-origin
 * by design, so anything from elsewhere is not ours to act on.
 */
export function pblStatusFromMessage(event: MessageEvent): PblSummaryStatus | null {
  if (event.origin !== window.location.origin) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== "object") return null;
  const { type } = data as { type?: unknown };
  if (type === "pbl-summary-ready") return "ready";
  if (type === "pbl-summary-failed") return "failed";
  return null;
}

/**
 * Track whether the framed viewer has finished, for one frame at a time.
 *
 * A module rather than an effect inline in the component, because what is worth
 * protecting here fails *silently* and the component itself is not reachable
 * from a test (rendering it needs a MapLibre pick result and a live iframe).
 * Four ways it can break with nothing on screen to say so:
 *
 * - not reading its inputs before the early return — the effect subscribes only
 *   to what its last run read, so it would never re-arm for the next
 *   neighbourhood and the splash would stay up for good;
 * - not resetting to "loading" — the second click shows the previous verdict
 *   over a blank frame;
 * - not watching the PAGE as well as the code — switching model-year tabs
 *   reloads the frame under an unchanged neighbourhood, and a status keyed on
 *   the code alone would keep the old tab's verdict while the new frame loads
 *   uncovered;
 * - no timeout — a frame that never reports leaves the splash covering a page
 *   the user could otherwise operate by hand.
 *
 * Call inside a reactive owner; the listener and timer are torn down with it.
 */
export function createPblSummaryStatus(
  buurtCode: Accessor<string | null>,
  page: Accessor<string>,
): Accessor<PblSummaryStatus> {
  const [status, setStatus] = createSignal<PblSummaryStatus>("loading");

  /**
   * What the frame is showing, deduplicated: the neighbourhood and the model
   * year's page, which together are exactly the iframe's `src`.
   *
   * `PblSummary` binds that `src` to these, so an unchanged pair leaves the
   * frame untouched — its script does not run again and it never sends another
   * verdict. But `FeatureInfo` derives the code from the pick result, so every
   * click is a fresh dependency even when it names the same neighbourhood:
   * clicking a highlighted feature's own outline picks it straight back. A
   * memo's `===` equality on the joined string absorbs that, and the effect
   * below re-runs only on a real change.
   *
   * It has to be absorbed HERE rather than by an early return inside the effect.
   * Solid runs a computation's cleanups BEFORE re-running it, so an effect that
   * re-runs and then declines to re-register has already dropped the listener
   * and the backstop belonging to a load still in flight — its verdict would
   * then arrive to nobody and the splash would never lift at all.
   */
  const frame = createMemo(() => {
    const code = buurtCode();
    // Read unconditionally: a null code must still subscribe to the page, or
    // picking a code-less feature would unsubscribe this memo from tab changes.
    const target = page();
    // The iframe's own src, so the key cannot disagree with what is loaded.
    return code ? pblSummaryUrl(code, target) : null;
  });

  createEffect(() => {
    // Read first, before anything can return early — see the note above.
    const current = frame();
    // A new frame is loading, so drop any verdict about the previous one.
    setStatus("loading");
    if (!current) return;

    // Backstop for a frame that never reports at all (see the constant).
    // Declared before the listener that cancels it: it exists for silence only,
    // so a frame that did answer must not be overruled by it twenty seconds on.
    const timer = setTimeout(() => setStatus("failed"), PBL_SUMMARY_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      const next = pblStatusFromMessage(event);
      if (!next) return;
      clearTimeout(timer);
      setStatus(next);
    }
    window.addEventListener("message", onMessage);

    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    });
  });

  return status;
}

/**
 * True when any layer under the pointer answers clicks with PBL's neighbourhood
 * summary. The popup uses it to size itself: an embedded viewer needs far more
 * room than an attribute table.
 */
export function resultUsesPblSummary(
  result: FeatureInfoResult,
  layerEntries: LayerEntry[],
): boolean {
  for (const configId of result.featuresByLayer.keys()) {
    const entry = layerEntries.find((candidate) => candidate.config.id === configId);
    if (entry?.config.featureinfo?.pbl === true) return true;
  }
  return false;
}
