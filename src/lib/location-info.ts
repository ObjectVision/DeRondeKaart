import type { FeatureInfoResult, PickedFeature } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { LocationInfoConfig } from "@/layers/types";

/** The click that opens "Locatie informatie": which layer, its config, the feature. */
export interface LocationInfoPick {
  layerId: string;
  config: LocationInfoConfig;
  feature: PickedFeature;
}

/**
 * The first layer under the pointer whose featureinfo is `locationinfo`, or
 * null. A layer that also sets `pbl` is skipped: the PBL summary wins, as the
 * precedence on FeatureInfoConfig says.
 */
export function findLocationInfoPick(
  result: FeatureInfoResult,
  layerEntries: LayerEntry[],
): LocationInfoPick | null {
  for (const [layerId, features] of result.featuresByLayer) {
    const info = layerEntries.find((entry) => entry.config.id === layerId)?.config.featureinfo;
    if (!info?.locationinfo || info.pbl === true || features.length === 0) continue;
    return { layerId, config: info.locationinfo, feature: features[0] };
  }
  return null;
}

/**
 * The pick without `layerId` — what the window's "Kaartlagen" tab shows. Null
 * when nothing else was hit, so the tab is left out.
 */
export function withoutLayer(result: FeatureInfoResult, layerId: string): FeatureInfoResult | null {
  const featuresByLayer = new Map(result.featuresByLayer);
  featuresByLayer.delete(layerId);
  if (featuresByLayer.size === 0) return null;
  return { ...result, featuresByLayer };
}
