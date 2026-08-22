import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";

/** Our own copy of PBL's viewer; see public/pbl-samenvatting.html. */
const PBL_SUMMARY_PAGE = "/pbl-samenvatting.html";

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
 * URL of the local PBL viewer for one neighbourhood. The page is ours and only
 * loads PBL's assets; it reads this parameter to drive their selection flow.
 */
export function pblSummaryUrl(buurtCode: string): string {
  const params = new URLSearchParams({ bu: buurtCode });
  return `${PBL_SUMMARY_PAGE}?${params.toString()}`;
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
