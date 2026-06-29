import type { ViewState } from "@/components/map/MapView";

/** Appearance of the marker dropped where the user clicks the map. */
export interface ClickMarkerConfig {
  /**
   * Either a Material Symbols icon **name** (e.g. "location_on") — resolved to
   * Google's hosted SVG — or a **path/URL** to a local SVG/PNG (e.g.
   * "/click-marker.svg"). See {@link resolveMarkerIconUrl}. Rendered as a tinted mask.
   */
  icon: string;
  /** Marker size in pixels. */
  size: number;
  /** Marker color as an [r, g, b, a] tuple (0–255). */
  color: [number, number, number, number];
}

/**
 * Resolve a `clickMarker.icon` value to an image URL the IconLayer can fetch.
 *
 * - A path/URL (contains "/" or "://", or ends in .svg/.png) is used as-is.
 * - Anything else is treated as a Material Symbols (Outlined) icon name and
 *   resolved to Google's hosted SVG for that symbol — so map.json can say
 *   `"icon": "location_on"` with no asset file. Note this is the default
 *   (unfilled) weight; for a filled glyph, ship a local SVG and use its path.
 */
export function resolveMarkerIconUrl(icon: string): string {
  const isPathOrUrl =
    icon.includes("/") || /\.(svg|png)$/i.test(icon);
  if (isPathOrUrl) return icon;
  return `https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/${icon}/default/24px.svg`;
}

/** Server-editable initial-view configuration, loaded from `public/map.json`. */
export interface MapConfig {
  /** Map center as [longitude, latitude]. */
  center: [number, number];
  /** Initial zoom level. */
  zoom: number;
  /**
   * Optional id (from layers.json) of a layer that is always loaded and pinned
   * on top of every other layer — including the basemap labels — on both maps.
   */
  studyarea?: string;
  /**
   * Whether a Google Street View panel opens on map click. Defaults to `false`
   * when omitted; set to `true` in map.json to enable it.
   */
  streetview?: boolean;
  /** Appearance of the on-click marker. Falls back to {@link DEFAULT_CLICK_MARKER}. */
  clickMarker: ClickMarkerConfig;
}

/** Default on-click marker: a purple pin at 40px. */
export const DEFAULT_CLICK_MARKER: ClickMarkerConfig = {
  icon: "/click-marker.svg",
  size: 40,
  color: [134, 59, 255, 255],
};

/** Fallback view, matching the hardcoded INITIAL_VIEW_STATE in MapView.tsx. */
export const DEFAULT_MAP_CONFIG: MapConfig = {
  center: [5.0, 52.0],
  zoom: 7,
  streetview: false,
  clickMarker: DEFAULT_CLICK_MARKER,
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

/** Coerce an [r,g,b] or [r,g,b,a] array of 0–255 ints into a color tuple. */
function validateColor(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return null;
  const ch = value.map((v) => Number(v));
  if (ch.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null;
  const [r, g, b, a = 255] = ch;
  return [r, g, b, a];
}

/**
 * Validate the optional `clickMarker` block, falling back per-field to
 * {@link DEFAULT_CLICK_MARKER}. Never returns null — a missing/invalid block
 * yields the default so the marker always renders.
 */
function validateClickMarker(value: unknown): ClickMarkerConfig {
  if (value === undefined) return DEFAULT_CLICK_MARKER;
  if (typeof value !== "object" || value === null) {
    console.warn(`map.json: invalid "clickMarker" ${JSON.stringify(value)}; using default`);
    return DEFAULT_CLICK_MARKER;
  }

  const obj = value as Record<string, unknown>;

  let icon = DEFAULT_CLICK_MARKER.icon;
  if (typeof obj.icon === "string" && obj.icon.length > 0) {
    icon = obj.icon;
  } else if (obj.icon !== undefined) {
    console.warn(`map.json: invalid clickMarker.icon ${JSON.stringify(obj.icon)}; using default`);
  }

  let size = DEFAULT_CLICK_MARKER.size;
  const s = Number(obj.size);
  if (Number.isFinite(s) && s > 0) {
    size = s;
  } else if (obj.size !== undefined) {
    console.warn(`map.json: invalid clickMarker.size ${JSON.stringify(obj.size)}; using default`);
  }

  let color = DEFAULT_CLICK_MARKER.color;
  const c = validateColor(obj.color);
  if (c) {
    color = c;
  } else if (obj.color !== undefined) {
    console.warn(`map.json: invalid clickMarker.color ${JSON.stringify(obj.color)}; using default`);
  }

  return { icon, size, color };
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

  let studyarea: string | undefined;
  if (typeof data.studyarea === "string" && data.studyarea.length > 0) {
    studyarea = data.studyarea;
  } else if (data.studyarea !== undefined) {
    console.warn(`map.json: invalid "studyarea" ${JSON.stringify(data.studyarea)}; ignoring`);
  }

  let streetview = DEFAULT_MAP_CONFIG.streetview;
  if (typeof data.streetview === "boolean") {
    streetview = data.streetview;
  } else if (data.streetview !== undefined) {
    console.warn(`map.json: invalid "streetview" ${JSON.stringify(data.streetview)}; using default`);
  }

  const clickMarker = validateClickMarker(data.clickMarker);

  return {
    center: center ?? DEFAULT_MAP_CONFIG.center,
    zoom: zoom ?? DEFAULT_MAP_CONFIG.zoom,
    studyarea,
    streetview,
    clickMarker,
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
