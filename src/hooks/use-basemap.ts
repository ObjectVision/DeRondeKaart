import { createSignal, type Accessor } from "solid-js";
import { DEFAULT_BASEMAP_ID, isBasemapId } from "@/components/map/map-view-config";
import { readStorage, writeStorage } from "@/lib/storage";

const STORAGE_KEY = "basemap.id";

export interface UseBasemapOptions {
  /** map.json `basemap`, used when the session has no stored choice. */
  configDefault?: string;
}

export interface UseBasemapResult {
  /** Id of the active basemap, passed to every MapView. */
  basemapId: Accessor<string>;
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
 * Every id that reaches this hook is validated: sessionStorage, map.json and
 * share URLs can all carry an id from an older build, and a stale one must fall
 * back rather than leave the map with no style.
 *
 * `configDefault` is read once, at initialisation — it comes from map.json and
 * is fixed for the session.
 */
export function useBasemap(options: UseBasemapOptions = {}): UseBasemapResult {
  const configDefault = options.configDefault;
  const stored = readStorage(sessionStorage, STORAGE_KEY);

  function initialBasemapId() {
    if (stored && isBasemapId(stored)) return stored;
    if (configDefault && isBasemapId(configDefault)) return configDefault;
    return DEFAULT_BASEMAP_ID;
  }

  const [basemapId, setBasemapId] = createSignal(initialBasemapId());

  function setBasemap(id: string) {
    if (!isBasemapId(id)) {
      console.warn(`Unknown basemap id "${id}"; keeping the current basemap`);
      return;
    }
    setBasemapId(id);
    writeStorage(sessionStorage, STORAGE_KEY, id);
  }

  return { basemapId, setBasemap };
}
