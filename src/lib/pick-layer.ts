import { getLayerConfigById, loadLayerConfigs } from "@/layers";
import type { MapSide } from "@/lib/map-side";

/**
 * The map.json `pickLayer`: an invisible layer whose only job is to answer
 * clicks.
 *
 * It is not in the navigation tree and not in the legend, so nothing puts it on
 * a map except this. **Both** maps get one — `useFeaturePick` queries only its
 * own side's layer stack, so without an entry on the right map a click there
 * finds nothing and silently does nothing.
 *
 * A pick layer is expected to set `excludeFromComparison`, so that having one on
 * the right map does not by itself count as "the maps are being compared" and
 * force the split view open. See `showMapRight` in App.tsx.
 */
export async function addPickLayer(
  side: MapSide,
  pickLayerId: string | undefined,
): Promise<void> {
  if (!pickLayerId) return;
  try {
    const config = getLayerConfigById(await loadLayerConfigs(), pickLayerId);
    if (!config) {
      console.warn(`map.json: pickLayer "${pickLayerId}" not found in layers.json`);
      return;
    }
    // `atEnd` keeps it at the bottom of the draw order rather than seeding it by
    // band. addLayer is idempotent on id, so re-adding to a map that already has
    // it is a no-op — which is what makes calling this on every right-map mount
    // safe.
    await side.layers.addLayer(config, { atEnd: true });
    side.layers.syncImperativeLayers();
  } catch (err) {
    // Non-fatal: the map is still usable, it just stops answering clicks.
    console.warn(`Failed to add pickLayer "${pickLayerId}":`, err);
  }
}
