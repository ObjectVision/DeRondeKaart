import { useCallback, useState } from "react";
import { BASEMAPS, DEFAULT_BASEMAP_ID, type Basemap } from "@/components/map/map-view-config";

export interface UseBasemapResult {
  /** Id of the active basemap, passed to every MapView. */
  basemapId: string;
  /** The one `cycleBasemap` will switch to — the legend button labels itself with it. */
  nextBasemap: Basemap;
  cycleBasemap: () => void;
}

/**
 * The selected background basemap, shared by both maps.
 *
 * Only the base style swaps; the user's layers stay. Swapping calls MapLibre's
 * `setStyle`, which wipes every source and layer, so each imperative overlay
 * re-adds itself from the map's `onLabelsReady` — App owns that wiring, because
 * the list of overlays to resync is per-map and not a property of the basemap.
 *
 * `cycleBasemap` reads the previous id inside the state updater rather than
 * closing over `basemapId`, so its identity is stable for the whole session and
 * the memoized Legend that receives it never re-renders on a basemap change.
 */
export function useBasemap(): UseBasemapResult {
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP_ID);

  const basemapIndex = Math.max(0, BASEMAPS.findIndex((b) => b.id === basemapId));
  const nextBasemap = BASEMAPS[(basemapIndex + 1) % BASEMAPS.length];

  const cycleBasemap = useCallback(() => {
    setBasemapId((prev) => {
      const i = Math.max(0, BASEMAPS.findIndex((b) => b.id === prev));
      return BASEMAPS[(i + 1) % BASEMAPS.length].id;
    });
  }, []);

  return { basemapId, nextBasemap, cycleBasemap };
}
