/**
 * Map constants and pure helpers used across the app.
 *
 * Split out of MapView.tsx so that file exports only components: mixing
 * component and non-component exports breaks React Fast Refresh, which then
 * full-reloads the page (and drops all map state) on every edit.
 */

export const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

export type ViewState = typeof INITIAL_VIEW_STATE;

/**
 * Selectable background basemaps. Each entry pairs a base style (background +
 * geometry, no labels — rendered under user data) with the matching overlay
 * (labels, roads, water — inserted into the overlay band by ensureAnchorsAndOverlay).
 * The `label` is what the legend's basemap toggle shows.
 */
export interface Basemap {
  id: string;
  label: string;
  base: string;
  overlay: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: "maptiler-basic",
    label: "MapTiler Basic",
    base: "/maptiler-basic-base.json",
    overlay: "/maptiler-basic-overlay.json",
  },
  // Positron is temporarily removed from the cycle (kept here for easy restore).
  // {
  //   id: "positron",
  //   label: "Positron",
  //   base: "/positron-base.json",
  //   overlay: "/positron-overlay.json",
  // },
  {
    // PDOK aerial photography (RGB 8cm). The imagery replaces the vector base;
    // only the labels (no roads/water) are drawn on top so place names stay
    // readable over the photo.
    id: "luchtfoto",
    label: "Luchtfoto",
    base: "/pdok-luchtfoto-base.json",
    overlay: "/maptiler-basic-labels.json",
  },
];

export const DEFAULT_BASEMAP_ID = BASEMAPS[0].id;

export function basemapById(id: string): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

/**
 * Named invisible anchor layers that partition the maplibre stack into z-order
 * bands. Every added layer sets its `beforeId` to one of these so both deck.gl
 * (interleaved) and native `map.addLayer` place it in the right band without any
 * after-the-fact `moveLayer` shuffling. Bottom → top:
 *
 *   basemap background layers
 *   [background-layers]
 *   normal added layers            → beforeid: "map-layers" (default)
 *   [map-layers]
 *   basemap overlay layers (labels/roads/water)
 *   [overlay-layers]
 *   foreground added layers        → beforeid: "foreground-layers"
 *   [foreground-layers]
 *   study area                     → beforeid: "studyarea-layers"
 *   [studyarea-layers]
 *   click marker / selection box   → no beforeId (topmost of all)
 *
 * `beforeId: X` inserts the layer in the band BELOW anchor X. A layer sets its
 * band per-config via `beforeid` (see anchorForConfig).
 */
export const ANCHORS = {
  background: "background-layers",
  map: "map-layers",
  overlay: "overlay-layers",
  foreground: "foreground-layers",
  studyarea: "studyarea-layers",
} as const;

/** Anchor ids as a set, for validating a config's `beforeid`. */
const ANCHOR_IDS = new Set<string>(Object.values(ANCHORS));

/**
 * The anchor a layer should sit below. Reads the config's `beforeid` (an anchor
 * id); defaults to `map-layers` (below the label overlay). Warns and falls back
 * to the default if `beforeid` names something that isn't a known anchor.
 */
export function anchorForConfig(config: { beforeid?: string }): string {
  const b = config.beforeid;
  if (!b) return ANCHORS.map;
  if (ANCHOR_IDS.has(b)) return b;
  console.warn(`layers.json: unknown beforeid "${b}"; using "${ANCHORS.map}"`);
  return ANCHORS.map;
}

/** Anchors in bottom→top order. */
export const ANCHOR_ORDER = [
  ANCHORS.background,
  ANCHORS.map,
  ANCHORS.overlay,
  ANCHORS.foreground,
  ANCHORS.studyarea,
];

