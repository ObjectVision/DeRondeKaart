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
    // Default. Same OpenMapTiles schema the Carto-hosted styles used, so the
    // layer definitions carried over unchanged — only the source, glyphs and
    // sprite differ.
    //
    // Two provider quirks are baked into the style files, and both fail
    // SILENTLY (missing labels, or a source that never loads) if reintroduced:
    //  - The source is the UNVERSIONED `/planet` TileJSON, not a pinned build
    //    path. A versioned path serves tiles but no tiles.json — it answers any
    //    unknown path with an empty 200 and `x-ofm-debug: empty tile`, which
    //    MapLibre cannot read. `/planet` currently resolves to build
    //    20260802_080001_pt.
    //  - Fonts are single-name Noto stacks. OpenFreeMap has no Open Sans, and
    //    404s any comma-joined fontstack, so the usual "preferred, fallback"
    //    pair does not work.
    id: "openfreemap",
    label: "OpenFreeMap",
    base: "/openfreemap-base.json",
    overlay: "/openfreemap-overlay.json",
  },
  {
    // PDOK aerial photography (RGB 8cm). The imagery replaces the vector base;
    // only the labels (no roads/water) are drawn on top so place names stay
    // readable over the photo.
    //
    // Its base style therefore declares the `openmaptiles` vector source even
    // though it draws nothing from it itself: ensureAnchorsAndOverlay copies an
    // overlay's LAYERS but not its SOURCES, so a label layer whose source is
    // missing from the base is dropped with "source not found" and the photo
    // silently loses every place name.
    id: "luchtfoto",
    label: "Luchtfoto",
    base: "/pdok-luchtfoto-base.json",
    overlay: "/openfreemap-labels.json",
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

/**
 * Which side of the basemap's label/road overlay a layer draws on: 1 for a
 * `beforeid: "foreground-layers"` config (above the labels), 0 for everything
 * else (below them, so place names stay readable over data).
 *
 * This is the one z-order fact that outranks draw order: the labels must keep
 * drawing over ordinary data layers, so restackNativeLayers restacks in two
 * passes split on this value, and the legend sorts on it before array order — a
 * drag reorders freely within a group but cannot lift a default-band layer over
 * the labels. Keep the two in step; they describe the same split.
 */
export function foregroundRank(config: { beforeid?: string }): number {
  return anchorForConfig(config) === ANCHORS.foreground ? 1 : 0;
}

