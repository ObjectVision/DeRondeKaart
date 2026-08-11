import { useCallback, useState } from "react";
import { DEFAULT_BASEMAP_ID, isBasemapId } from "@/components/map/map-view-config";
import { readStorage, writeStorage } from "@/lib/storage";

const STORAGE_KEY = "basemap.id";

export interface UseBasemapOptions {
  /** map.json `basemap`, used when the session has no stored choice. */
  configDefault?: string;
}

export interface UseBasemapResult {
  /** Id of the active basemap, passed to every MapView. */
  basemapId: string;
  /** Selects a basemap by id; an unknown id is ignored. */
  setBasemap: (id: string) => void;
}

/**
 * The selected background basemap, shared by both maps and remembered for the
 * session.
 *
 * Only the base style swaps; the user's layers stay. Swapping calls MapLibre's
 * `setStyle`, which wipes every source and layer, so each imperative overlay
 * re-adds itself from the map's `onLabelsReady` — App owns that wiring, because
 * the list of overlays to resync is per-map and not a property of the basemap.
 *
 * `setBasemap` never closes over `basemapId`, so its identity is stable for the
 * whole session and the memoized Legend that receives it does not re-render on a
 * basemap change.
 *
 * Every id that reaches this hook is validated: sessionStorage, map.json and
 * share URLs can all carry an id from an older build, and a stale one must fall
 * back rather than leave the map with no style.
 */
export function useBasemap({ configDefault }: UseBasemapOptions = {}): UseBasemapResult {
  const [basemapId, setBasemapId] = useState(() => {
    const stored = readStorage(sessionStorage, STORAGE_KEY);
    if (stored && isBasemapId(stored)) return stored;
    if (configDefault && isBasemapId(configDefault)) return configDefault;
    return DEFAULT_BASEMAP_ID;
  });

  const setBasemap = useCallback((id: string) => {
    if (!isBasemapId(id)) {
      console.warn(`Unknown basemap id "${id}"; keeping the current basemap`);
      return;
    }
    setBasemapId(id);
    writeStorage(sessionStorage, STORAGE_KEY, id);
  }, []);

  return { basemapId, setBasemap };
}
