import type { ViewState } from "@/components/map/MapView";

/** Server-editable initial-view configuration, loaded from `public/map.json`. */
export interface MapConfig {
  /** Map center as [longitude, latitude]. */
  center: [number, number];
  /** Initial zoom level. */
  zoom: number;
}

/** Fallback view, matching the hardcoded INITIAL_VIEW_STATE in MapView.tsx. */
export const DEFAULT_MAP_CONFIG: MapConfig = {
  center: [5.0, 52.0],
  zoom: 7,
};

const MIN_LAT = -85.05112878;
const MAX_LAT = 85.05112878;

function validateCenter(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -180 || lng > 180 || lat < MIN_LAT || lat > MAX_LAT) return null;
  return [lng, lat];
}

function validateZoom(value: unknown): number | null {
  const z = Number(value);
  if (!Number.isFinite(z)) return null;
  return Math.max(0, Math.min(22, z));
}

/**
 * Load `public/map.json` and produce a MapConfig. Never throws: on a missing
 * file, network error, or invalid/partial fields, the offending value falls
 * back to {@link DEFAULT_MAP_CONFIG} so an embedded map always loads.
 */
export async function loadMapConfig(): Promise<MapConfig> {
  let data: Record<string, unknown>;
  try {
    const response = await fetch("/map.json");
    if (!response.ok) {
      console.warn(`map.json: failed to load (${response.statusText}); using defaults`);
      return DEFAULT_MAP_CONFIG;
    }
    data = await response.json();
  } catch (err) {
    console.warn("map.json: not found or invalid JSON; using defaults", err);
    return DEFAULT_MAP_CONFIG;
  }

  const center = validateCenter(data.center);
  if (data.center !== undefined && center === null) {
    console.warn(`map.json: invalid "center" ${JSON.stringify(data.center)}; using default`);
  }
  const zoom = validateZoom(data.zoom);
  if (data.zoom !== undefined && zoom === null) {
    console.warn(`map.json: invalid "zoom" ${JSON.stringify(data.zoom)}; using default`);
  }

  return {
    center: center ?? DEFAULT_MAP_CONFIG.center,
    zoom: zoom ?? DEFAULT_MAP_CONFIG.zoom,
  };
}

/** Convert a MapConfig into the deck.gl/MapLibre view-state shape. */
export function toInitialViewState(cfg: MapConfig): ViewState {
  return {
    longitude: cfg.center[0],
    latitude: cfg.center[1],
    zoom: cfg.zoom,
    pitch: 0,
    bearing: 0,
  };
}
