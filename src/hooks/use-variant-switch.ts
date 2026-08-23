import type { Accessor } from "solid-js";
import type { MapViewHandle } from "@/components/map/map-view-config";
import { loadLayerConfigs } from "@/layers";
import { loadNavigation } from "@/layers/navigation";
import { isVariantId, setVariant, variantId } from "@/config/variant";
import { clearLayerInfoCache } from "@/components/ui/navigation/LayerDescription";
import { clearMetaUrlCache } from "@/components/ui/navigation/LeafMeta";
import type { useMapLayers } from "./use-map-layers";

interface MapSide {
  layers: ReturnType<typeof useMapLayers>;
  view: Accessor<MapViewHandle | null>;
}

export interface UseVariantSwitchOptions {
  mapLeft: MapSide;
  mapRight: MapSide;
  /**
   * Re-add the map.json `pickLayer` after the switch. It is added as an
   * ordinary layer entry, so the teardown below removes it along with
   * everything else — see the note in `switchVariant`.
   */
  onResetPickLayer?: () => void;
}

/**
 * Switch the active config variant (e.g. model year 2025 → 2026) without
 * reloading the app.
 *
 * What survives a switch, and why:
 *
 * - **The basemap** is a MapLibre style, not a layer entry — untouched.
 * - **The study area layer** loads through its own channel outside
 *   `useMapLayers` (see the header of `use-study-area-layer.ts`), so it is not
 *   in `layerEntries()` and is likewise untouched.
 * - **The map view** (centre/zoom) is never read or written here.
 * - **The pick layer** is the exception: `App.tsx` adds it with `addLayer`, so
 *   it *is* an ordinary entry and gets removed with the rest. It is re-added
 *   via `onResetPickLayer`, which re-arms the effect that owns it.
 *
 * Everything the user added is removed. That is deliberate rather than a
 * limitation: layer ids are reused between variants, so "keep what is on the
 * map" would silently repoint each layer at a different year's data.
 */
export function useVariantSwitch(options: UseVariantSwitchOptions) {
  /** Remove every layer entry from one map. */
  function clearSide(side: MapSide) {
    // Copy first: removeLayer mutates the entries signal as it goes, so
    // iterating the live array would skip every second layer.
    for (const entry of [...side.layers.layerEntries()]) {
      side.layers.removeLayer(entry.config.id);
    }
  }

  /**
   * Apply a variant switch. Resolves once the new variant's configs are parsed,
   * so a caller can await it before acting on the new layer set.
   *
   * Returns false when the id is unknown or already active, leaving the map
   * untouched — the teardown only runs once the switch is known to be real.
   */
  async function switchVariant(id: string): Promise<boolean> {
    // Validate BEFORE touching the maps. The id arrives from another page over
    // postMessage, so a typo there must not cost the user their layer stack:
    // an unknown id has to leave the session exactly as it was.
    if (id === variantId() || !isVariantId(id)) {
      if (!isVariantId(id)) console.warn(`Unknown variant "${id}"; ignoring`);
      return false;
    }

    // Order matters. The maps are cleared while the OLD variant is still
    // active, because removeLayer resolves each entry's config to find the
    // native sources/layers it owns.
    clearSide(options.mapLeft);
    clearSide(options.mapRight);

    // Id-keyed caches whose keys mean something different under the new
    // variant. (LeafMeta's URL-keyed HTML cache is safe and deliberately kept.)
    clearLayerInfoCache();
    clearMetaUrlCache();

    if (!setVariant(id)) return false;

    // Warm the new variant's configs before returning, so the navigation tree
    // and any queued command see a populated cache rather than racing the
    // fetch. Both are memoized per variant, so switching back is instant.
    await Promise.all([loadLayerConfigs(), loadNavigation()]);

    options.onResetPickLayer?.();
    return true;
  }

  return { switchVariant };
}
