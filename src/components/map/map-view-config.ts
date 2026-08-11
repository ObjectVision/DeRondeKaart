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
 * geometry, no labels — rendered under user data) with an optional overlay
 * (labels, roads, water — inserted into the overlay band by
 * ensureAnchorsAndOverlay). `label` names the option in the basemap picker and
 * `thumb` is its preview image.
 *
 * Three provider quirks are baked into every style file here, and all three fail
 * SILENTLY (missing labels, dropped icons, or a source that never loads) if
 * reintroduced:
 *  - The vector source is the UNVERSIONED `/planet` TileJSON, not a pinned build
 *    path. A versioned path serves tiles but no tiles.json — it answers any
 *    unknown path with an empty 200 and `x-ofm-debug: empty tile`, which
 *    MapLibre cannot read.
 *  - Fonts are single-name Noto stacks (Regular, Bold, Italic — the only three
 *    OpenFreeMap serves). It has no Open Sans and no Metropolis, and 404s any
 *    comma-joined fontstack, so the usual "preferred, fallback" pair fails.
 *  - Sprite ids use underscores (`circle_11`), not the hyphens the upstream
 *    OpenMapTiles styles ship (`circle-11`).
 *
 * Every base style must also declare the `openmaptiles` source even when it
 * draws nothing from it: ensureAnchorsAndOverlay copies an overlay's LAYERS but
 * not its SOURCES, so a label layer whose source is missing from the base is
 * dropped with "source not found".
 */
export interface Basemap {
  id: string;
  label: string;
  base: string;
  /**
   * Layers drawn ABOVE user data. Omitted by the label-less variants, which are
   * the base style alone — their roads and water draw *under* added layers.
   *
   * The `-roads-labels` overlays deliberately REPEAT the base's water and road
   * layers alongside the text, so the "met labels" variants show the network over
   * data as well as under it. Those copies carry an `__ovl` id suffix: MapLibre
   * would reject a duplicate id, and ensureAnchorsAndOverlay skips any layer whose
   * id already exists, so same-id copies would be silently dropped.
   */
  overlay?: string;
  /** Preview image in the picker. See BasemapDialog for how these are made. */
  thumb: string;
}

/**
 * Ordered for the picker's 3×2 grid, NOT by precedence — the default is the
 * explicit id below, never `BASEMAPS[0]`.
 *
 * The "kleur" pair is maptiler-basic and the "grijs" pair is positron. The base is
 * the complete published style minus its text (40 and 36 layers, in upstream
 * order), so a label-less variant is the base alone. The "met labels" variants add
 * an overlay holding the text plus a second copy of the water/road layers, which
 * is what puts the network back on top of user data.
 */
export const BASEMAPS: Basemap[] = [
  {
    // PDOK aerial photography (RGB 8cm) — the imagery replaces the vector base.
    id: "luchtfoto",
    label: "Luchtfoto",
    base: "/pdok-luchtfoto-base.json",
    thumb: "/basemap-thumb-luchtfoto.png",
  },
  {
    // Labels only (no roads/water) so place names stay readable over the photo.
    id: "luchtfoto-labels",
    label: "Luchtfoto met labels",
    base: "/pdok-luchtfoto-base.json",
    overlay: "/openfreemap-labels.json",
    thumb: "/basemap-thumb-luchtfoto-labels.png",
  },
  {
    // maptiler-basic, complete except for its text layers — no overlay at all.
    id: "kleur",
    label: "Kleur",
    base: "/openfreemap-base.json",
    thumb: "/basemap-thumb-kleur.png",
  },
  {
    // The same base, plus water/roads AND labels drawn again above user data.
    id: "kleur-labels",
    label: "Kleur met labels",
    base: "/openfreemap-base.json",
    overlay: "/openfreemap-roads-labels.json",
    thumb: "/basemap-thumb-kleur-labels.png",
  },
  {
    id: "grijs",
    label: "Grijs",
    base: "/positron-base.json",
    thumb: "/basemap-thumb-grijs.png",
  },
  {
    id: "grijs-labels",
    label: "Grijs met labels",
    base: "/positron-base.json",
    overlay: "/positron-roads-labels.json",
    thumb: "/basemap-thumb-grijs-labels.png",
  },
];

/**
 * Spelled out rather than derived from `BASEMAPS[0]`: the array order is the
 * picker's display order and may be rearranged, which must not silently move
 * the default.
 */
export const DEFAULT_BASEMAP_ID = "kleur-labels";

/** Falls back to the default basemap, not to `BASEMAPS[0]` (a display slot). */
export function basemapById(id: string): Basemap {
  return (
    BASEMAPS.find((b) => b.id === id) ??
    BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP_ID) ??
    BASEMAPS[0]
  );
}

/**
 * Whether `id` names a basemap. Ids arrive from sessionStorage, share URLs and
 * map.json, all of which can carry a stale value from an older build.
 */
export function isBasemapId(id: string): boolean {
  return BASEMAPS.some((b) => b.id === id);
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

