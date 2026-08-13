import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";

/** Our own copy of PBL's viewer; see public/pbl-samenvatting.html. */
const PBL_SUMMARY_PAGE = "/pbl-samenvatting.html";

/**
 * A CBS neighbourhood code: "BU" followed by a 4-digit gemeente and a 4-digit
 * buurt. The viewer derives the gemeente from it, so the shape is load-bearing
 * and checked rather than assumed.
 */
const BU_CODE_RE = /^BU\d{8}$/;

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
