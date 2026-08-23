import type { ViewState } from "@/components/map/MapView";
import { isBasemapId } from "@/components/map/map-view-config";
import { loadConfig, clearConfigCache } from "@/config/load-config";

/** Appearance of the marker dropped where the user clicks the map. */
export interface ClickMarkerConfig {
  /**
   * Render the marker at all. `false` disables it (clicks still open feature
   * info popups — only the dropped pin is suppressed). map.json can also use
   * the shorthand `"clickMarker": false`. Defaults to `true`.
   */
  enabled: boolean;
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

/**
 * map.json `dashboard` — which dashboard modes a project offers.
 *
 * One key rather than two booleans because the modes are a single editorial
 * choice per project, and the four names read in the config file without a
 * schema at hand.
 */
export type DashboardMode = "off" | "standalone" | "complementary" | "both";

/** Whether `?mode=dashboard` may boot the map-less dashboard. */
export function standaloneDashboardEnabled(mode: DashboardMode): boolean {
  return mode === "standalone" || mode === "both";
}

/** Whether the map app may offer area comparison ("meer informatie"). */
export function complementaryDashboardEnabled(mode: DashboardMode): boolean {
  return mode === "complementary" || mode === "both";
}

/** Server-editable initial-view configuration, loaded from `public/map.json`. */
/** One selectable config variant, e.g. a model year. */
export interface VariantItem {
  /** Directory name under the project config dir, e.g. "2026". */
  id: string;
  /** Dutch label for the host page to show. */
  label: string;
}

/**
 * Optional runtime config variants. When present, `layers.json` and
 * `navigation.json` are fetched from `/<variant-id>/` instead of the site root,
 * and the host page can switch between them without reloading the app.
 * See `src/config/variant.ts`.
 */
export interface VariantsConfig {
  /** Variant selected when the URL names none. Defaults to the first item. */
  default?: string;
  items: VariantItem[];
}

export interface MapConfig {
  /** Map center as [longitude, latitude]. */
  center: [number, number];
  /** Initial zoom level. */
  zoom: number;
  /**
   * Optional set of config variants (e.g. model years 2025/2026) the project
   * ships side by side. Omitted for single-dataset projects, which keeps their
   * config fetches at the site root exactly as before.
   */
  variants?: VariantsConfig;
  /**
   * Optional id (from layers.json) of a layer that is always loaded and pinned
   * on top of every other layer — including the basemap labels — on both maps.
   */
  studyarea?: string;
  /**
   * Optional id (from layers.json) of a layer added to the left map at startup
   * purely so map clicks have something to hit — it answers the click and is
   * never seen. Used for the startanalyse2026 buurt layer, which makes the whole
   * country clickable without the user adding a layer first.
   *
   * The layer must be invisible through its `style.opacity`, NOT through the
   * legend's hide toggle: hiding sets `visibility: none`, which drops it from
   * `queryRenderedFeatures` and would silently stop the clicks working. Give it
   * `excludeFromLegend` so that toggle is out of reach.
   */
  pickLayer?: string;
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
   * Id of the basemap a fresh session starts on (see BASEMAPS). Omitted or
   * unknown falls back to DEFAULT_BASEMAP_ID. A stored session choice wins over
   * this; a basemap in a share URL wins over both.
   */
  basemap?: string;
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
  /**
   * Whether the "Delen" (share/export) feature is available: the share
   * toolbutton in the top-left toolbar and its dialog (share URL, circular
   * PNG export). Defaults to `true`.
   */
  share: boolean;
  /**
   * Whether changing the area filter (Gemeente/Wijk/Buurt) flies the maps to
   * the selected areas (centroid + fitting zoom). Defaults to `true`.
   */
  filterFlyTo: boolean;
  /**
   * Whether the "Criteria combineren" feature is available: the `masked_transitions_add`
   * toolbutton and its dialog, plus the "Combinaties" theme appended to the
   * navigation tree. Defaults to `false` — only configs whose layers carry
   * `filterRaster` companions can combine anything.
   */
  combinations: boolean;
  /**
   * Which dashboard modes this project offers. Defaults to `"off"`.
   *
   * - `"standalone"` — `?mode=dashboard` boots the map-less dashboard.
   * - `"complementary"` — the map stays live and areas can be compared in it.
   * - `"both"` — either entry point works.
   *
   * Read through {@link standaloneDashboardEnabled} /
   * {@link complementaryDashboardEnabled} rather than compared by hand.
   */
  dashboard: DashboardMode;
  /**
   * Whether the annotation tool is available: the top-right toolbutton that
   * arms circle-drawing (with per-circle title/description + a snapshot of
   * filters/layers/camera) and, combined with `share`, collaborative
   * annotation sessions over the `/collab` WebSocket. Defaults to `false`.
   */
  annotations: boolean;
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
  /**
   * CSS color of the UI-chrome button icons (map controls, plus the "active"
   * brand state of the section-toggle / area-select buttons). Any CSS color
   * string. Defaults to {@link DEFAULT_CHROME_ICON_COLOR}. Read at runtime via
   * {@link chromeIconColor}.
   */
  chromeIconColor: string;
  /**
   * Pixel size of the MAIN-level navigation icons — the sidebar's theme rows
   * and, in `top` mode, the category cards. Branch and leaf rows inside the
   * tree are not affected.
   *
   * `undefined` when the key is absent, which means "leave every call site at
   * its own default" rather than any one number — the two main-level sites
   * disagree (24 sidebar, 32 panel). Read at runtime via {@link navIconSize},
   * which takes that per-site default as its argument.
   *
   * Worth raising for configs whose icons are wide: the value is the icon's
   * height, so a 3:2 asset renders 1.5x as wide as it is tall.
   */
  navIconSize?: number;
}

/** Default pixel size of the UI-chrome toggle/header icons. */
const DEFAULT_CHROME_ICON_SIZE = 20;

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

/** Default CSS color of the UI-chrome button icons. */
const DEFAULT_CHROME_ICON_COLOR = "#3E74A7";

/**
 * Module-level cache of the effective chrome icon color, set once by
 * {@link loadMapConfig}. UI-chrome components read it via {@link chromeIconColor}.
 */
let chromeIconColorValue = DEFAULT_CHROME_ICON_COLOR;

/** Current UI-chrome icon color, configurable via `map.json`'s `chromeIconColor`. */
export function chromeIconColor(): string {
  return chromeIconColorValue;
}

/**
 * Module-level cache of the configured main-level nav icon size, set by
 * {@link loadMapConfig}. Stays `undefined` when `map.json` omits the key.
 */
let navIconSizeValue: number | undefined;

/**
 * Main-level navigation icon size (px) from `map.json`, or `fallback` when the
 * key is absent.
 *
 * Unlike {@link chromeIconSize} this takes the caller's own default rather than
 * owning one: the sidebar's theme rows use 24 and the top-mode category cards
 * use 32, so a single module-level default could not leave both untouched for
 * configs that never set the key.
 */
export function navIconSize(fallback: number): number {
  return navIconSizeValue ?? fallback;
}

/** Default map controls: both search and zoom visible. */
export const DEFAULT_MAP_CONTROLS: MapControlsConfig = {
  search: true,
  zoom: true,
};

/** Default on-click marker: a purple pin at 40px, no offset. */
export const DEFAULT_CLICK_MARKER: ClickMarkerConfig = {
  enabled: true,
  icon: "/click-marker.svg",
  size: 40,
  color: [134, 59, 255, 255],
  offsetX: 0,
  offsetY: 0,
};

/** Fallback view, matching the hardcoded INITIAL_VIEW_STATE in MapView.tsx. */
const MAP_CONFIG_FILE = "map.json";

const DEFAULT_MAP_CONFIG: MapConfig = {
  center: [5.0, 52.0],
  zoom: 7,
  streetview: false,
  searchbar: false,
  navigation: false,
  navigationMode: "top",
  filterSection: true,
  navigationSection: true,
  chartsPanel: true,
  share: true,
  filterFlyTo: true,
  combinations: false,
  dashboard: "off",
  annotations: false,
  mapControls: DEFAULT_MAP_CONTROLS,
  clickMarker: DEFAULT_CLICK_MARKER,
  chromeIconSize: DEFAULT_CHROME_ICON_SIZE,
  chromeIconColor: DEFAULT_CHROME_ICON_COLOR,
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
 * Validate the optional `variants` block. Returns null (variants disabled) for
 * anything malformed, so a typo degrades to the single-dataset behaviour that
 * every project had before rather than breaking the boot.
 *
 * Ids become URL path segments, so they are restricted to characters that are
 * safe unescaped and cannot walk out of the project directory.
 */
const VARIANT_ID_RE = /^[A-Za-z0-9_-]+$/;

function validateVariants(value: unknown): VariantsConfig | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.warn(`map.json: invalid "variants" ${JSON.stringify(value)}; ignoring`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.items)) {
    console.warn('map.json: "variants" needs an "items" array; ignoring');
    return null;
  }

  const items: VariantItem[] = [];
  for (const entry of raw.items) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !VARIANT_ID_RE.test(id)) {
      console.warn(`map.json: invalid variant id ${JSON.stringify(id)}; skipping`);
      continue;
    }
    if (items.some((i) => i.id === id)) {
      console.warn(`map.json: duplicate variant id "${id}"; skipping`);
      continue;
    }
    items.push({ id, label: typeof label === "string" && label ? label : id });
  }

  if (items.length === 0) {
    console.warn('map.json: "variants" has no usable items; ignoring');
    return null;
  }

  let def = items[0].id;
  if (typeof raw.default === "string") {
    if (items.some((i) => i.id === raw.default)) {
      def = raw.default;
    } else {
      console.warn(
        `map.json: variants.default "${raw.default}" is not in items; using "${def}"`,
      );
    }
  }

  return { default: def, items };
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
  // Shorthand: `"clickMarker": false` disables the marker entirely.
  if (value === false) return { ...DEFAULT_CLICK_MARKER, enabled: false };
  if (typeof value !== "object" || value === null) {
    console.warn(`map.json: invalid "clickMarker" ${JSON.stringify(value)}; using default`);
    return DEFAULT_CLICK_MARKER;
  }

  const obj = value as Record<string, unknown>;

  let enabled = DEFAULT_CLICK_MARKER.enabled;
  if (typeof obj.enabled === "boolean") {
    enabled = obj.enabled;
  } else if (obj.enabled !== undefined) {
    console.warn(`map.json: invalid clickMarker.enabled ${JSON.stringify(obj.enabled)}; using default`);
  }

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

  return { enabled, icon, size, color, offsetX, offsetY };
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
  // Not memoized, unlike the other eight: this runs once at boot, before the
  // variant system is initialised (it is map.json that declares the variants),
  // and re-reading it is how a test drives a different config.
  clearConfigCache(MAP_CONFIG_FILE);
  return loadConfig({
    name: MAP_CONFIG_FILE,
    onError: () => DEFAULT_MAP_CONFIG,
    parse: (raw) => buildMapConfig(raw as Record<string, unknown>),
  });
}

/** Validate and default every field of a parsed map.json. */
function buildMapConfig(data: Record<string, unknown>): MapConfig {
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

  let pickLayer: string | undefined;
  if (typeof data.pickLayer === "string" && data.pickLayer.length > 0) {
    pickLayer = data.pickLayer;
  } else if (data.pickLayer !== undefined) {
    console.warn(`map.json: invalid "pickLayer" ${JSON.stringify(data.pickLayer)}; ignoring`);
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
  const share = validateBool(data.share, "share", DEFAULT_MAP_CONFIG.share);
  const filterFlyTo = validateBool(data.filterFlyTo, "filterFlyTo", DEFAULT_MAP_CONFIG.filterFlyTo);
  const combinations = validateBool(data.combinations, "combinations", DEFAULT_MAP_CONFIG.combinations);
  const annotations = validateBool(data.annotations, "annotations", DEFAULT_MAP_CONFIG.annotations);

  let navigationMode = DEFAULT_MAP_CONFIG.navigationMode;
  if (data.navigationMode === "top" || data.navigationMode === "sidebar") {
    navigationMode = data.navigationMode;
  } else if (data.navigationMode !== undefined) {
    console.warn(
      `map.json: invalid "navigationMode" ${JSON.stringify(data.navigationMode)}; using "top"`,
    );
  }

  let dashboard = DEFAULT_MAP_CONFIG.dashboard;
  if (
    data.dashboard === "off" ||
    data.dashboard === "standalone" ||
    data.dashboard === "complementary" ||
    data.dashboard === "both"
  ) {
    dashboard = data.dashboard;
  } else if (data.dashboard !== undefined) {
    console.warn(
      `map.json: invalid "dashboard" ${JSON.stringify(data.dashboard)}; using "off"`,
    );
  }

  let basemap: string | undefined;
  if (typeof data.basemap === "string" && isBasemapId(data.basemap)) {
    basemap = data.basemap;
  } else if (data.basemap !== undefined) {
    console.warn(
      `map.json: unknown "basemap" ${JSON.stringify(data.basemap)}; using the default basemap`,
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

  let chromeColor = DEFAULT_CHROME_ICON_COLOR;
  if (typeof data.chromeIconColor === "string" && data.chromeIconColor.length > 0) {
    chromeColor = data.chromeIconColor;
  } else if (data.chromeIconColor !== undefined) {
    console.warn(
      `map.json: invalid "chromeIconColor" ${JSON.stringify(data.chromeIconColor)}; using default`,
    );
  }
  chromeIconColorValue = chromeColor;

  // Absent stays undefined (each call site keeps its own default); a bad value
  // warns and does the same, rather than substituting a number nobody asked for.
  let navIcon: number | undefined;
  const ni = Number(data.navIconSize);
  if (Number.isFinite(ni) && ni > 0) {
    navIcon = ni;
  } else if (data.navIconSize !== undefined) {
    console.warn(
      `map.json: invalid "navIconSize" ${JSON.stringify(data.navIconSize)}; using default`,
    );
  }
  navIconSizeValue = navIcon;

  const variants = validateVariants(data.variants);

  return {
    center: center ?? DEFAULT_MAP_CONFIG.center,
    zoom: zoom ?? DEFAULT_MAP_CONFIG.zoom,
    variants: variants ?? undefined,
    studyarea,
    pickLayer,
    streetview,
    searchbar,
    navigation,
    navigationMode,
    basemap,
    filterSection,
    navigationSection,
    chartsPanel,
    share,
    filterFlyTo,
    combinations,
    dashboard,
    annotations,
    mapControls,
    clickMarker,
    chromeIconSize: chromeIcon,
    chromeIconColor: chromeColor,
    navIconSize: navIcon,
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
