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
  /**
   * Pixel offset applied to the rendered icon relative to the click point.
   * Positive X moves right, positive Y moves **down**. Use this to align the
   * icon's visual center with the mouse pointer (e.g. nudge `my_location` down).
   */
  offsetX: number;
  offsetY: number;
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

/**
 * Visibility of the individual map controls (search-tool and zoom +/-). These
 * work independently of the `searchbar`/`navigation` UI flags: even with the
 * navigation UI off, this card renders standalone (bottom-right) so an embedded
 * map can offer just search and/or zoom.
 */
export interface MapControlsConfig {
  /** Show the location-search tool. Defaults to `true`. */
  search: boolean;
  /** Show the zoom-in / zoom-out buttons. Defaults to `true`. */
  zoom: boolean;
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
  /**
   * Whether the search bar (the "Zoek een kaartlaag…" input) is shown.
   * Defaults to `false` when omitted.
   */
  searchbar: boolean;
  /**
   * Whether the navigation controls (category row + zoom +/- controls) are
   * shown. Defaults to `false` when omitted.
   */
  navigation: boolean;
  /**
   * Layout of the navigation UI: `"top"` shows the top-center category row,
   * `"sidebar"` shows the left sidebar with Filter + Navigatie sections and
   * hides the top-center row. Only meaningful when `navigation` is true.
   * Defaults to `"top"` when omitted.
   */
  navigationMode: "top" | "sidebar";
  /**
   * Whether the sidebar's Filter section is available. Only meaningful in
   * sidebar mode when `navigation` is true. Defaults to `true`. Set to `false`
   * to hide the Filter box (and its top-right toggle icon) entirely.
   */
  filterSection: boolean;
  /**
   * Whether the sidebar's Navigatie (Kaartlagen) section is available. Only
   * meaningful in sidebar mode when `navigation` is true. Defaults to `true`.
   * Set to `false` to hide the Navigatie box (and its top-right toggle icon).
   */
  navigationSection: boolean;
  /**
   * Whether the analytics ("Analyse & statistieken") panel is available:
   * clicking a chart-configured layer's name in the legend opens it. Defaults
   * to `true`.
   */
  chartsPanel: boolean;
  /** Visibility of the search-tool / zoom controls. Both default to `true`. */
  mapControls: MapControlsConfig;
  /** Appearance of the on-click marker. Falls back to {@link DEFAULT_CLICK_MARKER}. */
  clickMarker: ClickMarkerConfig;
  /**
   * Pixel size of the UI-chrome toggle/header icons (legend collapse bar,
   * sidebar section toggles, navigation panel, legend header). Defaults to
   * {@link DEFAULT_CHROME_ICON_SIZE}. Read at runtime via {@link chromeIconSize}.
   */
  chromeIconSize: number;
}

/** Default pixel size of the UI-chrome toggle/header icons. */
export const DEFAULT_CHROME_ICON_SIZE = 20;

/**
 * Module-level cache of the effective chrome icon size, set once by
 * {@link loadMapConfig}. UI-chrome components that don't receive the MapConfig
 * as a prop read it via {@link chromeIconSize}.
 */
let chromeIconSizeValue = DEFAULT_CHROME_ICON_SIZE;

/** Current UI-chrome icon size (px), configurable via `map.json`'s `chromeIconSize`. */
export function chromeIconSize(): number {
  return chromeIconSizeValue;
}

/** Default map controls: both search and zoom visible. */
export const DEFAULT_MAP_CONTROLS: MapControlsConfig = {
  search: true,
  zoom: true,
};

/** Default on-click marker: a purple pin at 40px, no offset. */
export const DEFAULT_CLICK_MARKER: ClickMarkerConfig = {
  icon: "/click-marker.svg",
  size: 40,
  color: [134, 59, 255, 255],
  offsetX: 0,
  offsetY: 0,
};

/** Fallback view, matching the hardcoded INITIAL_VIEW_STATE in MapView.tsx. */
export const DEFAULT_MAP_CONFIG: MapConfig = {
  center: [5.0, 52.0],
  zoom: 7,
  streetview: false,
  searchbar: false,
  navigation: false,
  navigationMode: "top",
  filterSection: true,
  navigationSection: true,
  chartsPanel: true,
  mapControls: DEFAULT_MAP_CONTROLS,
  clickMarker: DEFAULT_CLICK_MARKER,
  chromeIconSize: DEFAULT_CHROME_ICON_SIZE,
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

  // Pixel offsets — any finite number (negative allowed); default 0.
  const validateOffset = (raw: unknown, key: string, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.warn(`map.json: invalid clickMarker.${key} ${JSON.stringify(raw)}; using default`);
    return fallback;
  };
  const offsetX = validateOffset(obj.offsetX, "offsetX", DEFAULT_CLICK_MARKER.offsetX);
  const offsetY = validateOffset(obj.offsetY, "offsetY", DEFAULT_CLICK_MARKER.offsetY);

  return { icon, size, color, offsetX, offsetY };
}

/**
 * Validate the optional `mapControls` block, falling back per-field to
 * {@link DEFAULT_MAP_CONTROLS}. Never returns null — a missing/invalid block
 * yields the default so the controls always render.
 */
function validateMapControls(value: unknown): MapControlsConfig {
  if (value === undefined) return DEFAULT_MAP_CONTROLS;
  if (typeof value !== "object" || value === null) {
    console.warn(`map.json: invalid "mapControls" ${JSON.stringify(value)}; using default`);
    return DEFAULT_MAP_CONTROLS;
  }

  const obj = value as Record<string, unknown>;

  const validateFlag = (raw: unknown, key: string, fallback: boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    if (raw !== undefined) {
      console.warn(`map.json: invalid mapControls.${key} ${JSON.stringify(raw)}; using default`);
    }
    return fallback;
  };

  return {
    search: validateFlag(obj.search, "search", DEFAULT_MAP_CONTROLS.search),
    zoom: validateFlag(obj.zoom, "zoom", DEFAULT_MAP_CONTROLS.zoom),
  };
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

  const validateBool = (raw: unknown, key: string, fallback: boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    if (raw !== undefined) {
      console.warn(`map.json: invalid "${key}" ${JSON.stringify(raw)}; using default`);
    }
    return fallback;
  };

  const streetview = validateBool(data.streetview, "streetview", DEFAULT_MAP_CONFIG.streetview!);
  const searchbar = validateBool(data.searchbar, "searchbar", DEFAULT_MAP_CONFIG.searchbar);
  const navigation = validateBool(data.navigation, "navigation", DEFAULT_MAP_CONFIG.navigation);
  const filterSection = validateBool(data.filterSection, "filterSection", DEFAULT_MAP_CONFIG.filterSection);
  const navigationSection = validateBool(
    data.navigationSection,
    "navigationSection",
    DEFAULT_MAP_CONFIG.navigationSection,
  );
  const chartsPanel = validateBool(data.chartsPanel, "chartsPanel", DEFAULT_MAP_CONFIG.chartsPanel);

  let navigationMode = DEFAULT_MAP_CONFIG.navigationMode;
  if (data.navigationMode === "top" || data.navigationMode === "sidebar") {
    navigationMode = data.navigationMode;
  } else if (data.navigationMode !== undefined) {
    console.warn(
      `map.json: invalid "navigationMode" ${JSON.stringify(data.navigationMode)}; using "top"`,
    );
  }

  const mapControls = validateMapControls(data.mapControls);
  const clickMarker = validateClickMarker(data.clickMarker);

  let chromeIcon = DEFAULT_CHROME_ICON_SIZE;
  const ci = Number(data.chromeIconSize);
  if (Number.isFinite(ci) && ci > 0) {
    chromeIcon = ci;
  } else if (data.chromeIconSize !== undefined) {
    console.warn(
      `map.json: invalid "chromeIconSize" ${JSON.stringify(data.chromeIconSize)}; using default`,
    );
  }
  chromeIconSizeValue = chromeIcon;

  return {
    center: center ?? DEFAULT_MAP_CONFIG.center,
    zoom: zoom ?? DEFAULT_MAP_CONFIG.zoom,
    studyarea,
    streetview,
    searchbar,
    navigation,
    navigationMode,
    filterSection,
    navigationSection,
    chartsPanel,
    mapControls,
    clickMarker,
    chromeIconSize: chromeIcon,
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
