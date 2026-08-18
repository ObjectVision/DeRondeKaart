/**
 * Map constants, shared map types, and pure helpers used across the app.
 *
 * Split out of MapView.tsx so that file exports only components. The map types
 * live here rather than in MapView.tsx so that no module has to import a type
 * from a component file in order to talk about the map — `layers/`, `lib/` and
 * `config/` all need them and none of them should depend on a component.
 */

import type { Accessor } from "solid-js";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";

export const INITIAL_VIEW_STATE = {
  longitude: 5.0,
  latitude: 52.0,
  zoom: 7,
  pitch: 0,
  bearing: 0,
};

export type ViewState = typeof INITIAL_VIEW_STATE;

/**
 * Late-bound access to the live MapLibre instance; null before the map has been
 * constructed. Replaces react-map-gl's `MapRef`, which also proxied every `Map`
 * method and the declarative props — the app used neither, every call site
 * immediately reached for `getMap()` and worked against the raw instance.
 *
 * A plain function type, so it doubles as a Solid accessor (reading it inside an
 * effect subscribes that effect to the map appearing) and as something the
 * imperative callers outside any reactive scope — the composite host on
 * `moveend`, worker completions — can call directly.
 */
export type MapAccessor = Accessor<MapLibreMap | null>;

/**
 * Handle a `MapView` publishes to its parent via `ref`.
 *
 * Both members are accessors rather than the mutable refs the React version
 * used: `drawMode` was a ref purely so `use-hover-cursor`'s MapLibre callback
 * could read the current value without a stale closure, which is exactly what a
 * signal gives for free.
 */
export interface MapViewHandle {
  /** The live MapLibre instance, or null until the map has mounted. */
  map: MapAccessor;
  /** Live flag: the area-select draw mode is armed (crosshair cursor). */
  drawMode: Accessor<boolean>;
  setDrawMode(armed: boolean): void;
}

/**
 * Pointer event on the map.
 *
 * react-map-gl's `MapLayerMouseEvent` added a `features` array, populated by
 * running `queryRenderedFeatures` for the layers named in `interactiveLayerIds`.
 * This app never set that prop and never read `features` — picking goes through
 * `queryRenderedFeatures` explicitly (see use-feature-pick.ts) so that it can
 * control the query box and layer set — so the plain MapLibre event is enough.
 */
export type MapLayerMouseEvent = MapMouseEvent;

/**
 * Camera change reported while the map moves. Only `viewState` is ever read.
 */
export interface ViewStateChangeEvent {
  viewState: ViewState;
}

/**
 * Selectable background basemaps. Each entry pairs a base style (background +
 * geometry, no labels — rendered under user data) with an optional overlay
 * (labels, roads, water — inserted into the overlay band by
 * ensureAnchorsAndOverlay).
 *
 * The picker presents this as three circles (BASEMAP_BASES) plus per-base
 * checkboxes; each entry below is one base × option combination, and its `id` is
 * what the app persists.
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
/** The three background maps the picker offers as circles. */
export type BasemapBaseId = "luchtfoto" | "kleur" | "grijs";

/** The checkboxes a base can offer, each promoting part of the basemap above user data. */
export type BasemapOptionKey = "labels" | "roads";

/** Which of those checkboxes are ticked. */
export interface BasemapOptions {
  /** Place names and other text drawn above user data. */
  labels: boolean;
  /** Roads and waterways drawn above user data instead of under it. */
  roads: boolean;
}

export interface Basemap {
  id: string;
  label: string;
  base: string;
  /**
   * Layers drawn ABOVE user data. Omitted when no option is ticked, leaving the
   * base style alone — its roads and water then draw *under* added layers.
   *
   * The overlays that include the network deliberately REPEAT the base's water and
   * road layers, so those variants show the network over data as well as under it.
   * Those copies carry an `__ovl` id suffix: MapLibre would reject a duplicate id,
   * and ensureAnchorsAndOverlay skips any layer whose id already exists, so
   * same-id copies would be silently dropped.
   */
  overlay?: string;
  /** Preview image in the picker. See BasemapDialog for how these are made. */
  thumb: string;
  /** The circle this entry sits under in the picker. */
  baseId: BasemapBaseId;
  /** The option combination this entry represents. */
  options: BasemapOptions;
}

/**
 * The three circles in the picker, in display order.
 *
 * `supports` lists the checkboxes each one offers. Luchtfoto omits "roads": it is
 * raster imagery with no vector network to promote, so the option would have
 * nothing to act on. Driving the dialog off this list keeps that exception in the
 * data rather than in a component branch.
 */
export interface BasemapBase {
  id: BasemapBaseId;
  label: string;
  thumb: string;
  supports: readonly BasemapOptionKey[];
}

export const BASEMAP_BASES: BasemapBase[] = [
  {
    id: "luchtfoto",
    label: "Luchtfoto",
    thumb: "/basemap-thumb-luchtfoto.png",
    supports: ["labels"],
  },
  {
    id: "kleur",
    label: "Kleur",
    thumb: "/basemap-thumb-kleur.png",
    supports: ["labels", "roads"],
  },
  {
    id: "grijs",
    label: "Grijs",
    thumb: "/basemap-thumb-grijs.png",
    supports: ["labels", "roads"],
  },
];

/**
 * Every base × option combination the picker can produce: two for Luchtfoto (which
 * has no "roads" option) and four each for Kleur and Grijs. The picker renders
 * BASEMAP_BASES, not this list — these entries are what a chosen combination
 * resolves to, and what the rest of the app persists as a single id.
 *
 * "kleur" is maptiler-basic and "grijs" is positron. Each base style is the complete
 * published style minus its text (40 and 36 layers, in upstream order), so the
 * no-options variant is the base alone.
 *
 * The ids are NOT mechanically derived from the options, and deliberately so:
 * `kleur-labels`/`grijs-labels` predate the two-checkbox UI and already mean labels
 * AND network, so they keep that meaning and labels-without-network takes the
 * `-labels-only` suffix. Renaming them would break every share link and stored
 * session already in the wild. basemapIdFor/basemapOptionsOf are the only code that
 * needs to know this, which is why both go through the table rather than string
 * concatenation.
 */
export const BASEMAPS: Basemap[] = [
  {
    // PDOK aerial photography (RGB 8cm) — the imagery replaces the vector base.
    id: "luchtfoto",
    label: "Luchtfoto",
    base: "/pdok-luchtfoto-base.json",
    thumb: "/basemap-thumb-luchtfoto.png",
    baseId: "luchtfoto",
    options: { labels: false, roads: false },
  },
  {
    // Labels only (no roads/water) so place names stay readable over the photo.
    id: "luchtfoto-labels",
    label: "Luchtfoto met labels",
    base: "/pdok-luchtfoto-base.json",
    overlay: "/openfreemap-labels.json",
    thumb: "/basemap-thumb-luchtfoto-labels.png",
    baseId: "luchtfoto",
    options: { labels: true, roads: false },
  },
  {
    // maptiler-basic, complete except for its text layers — no overlay at all.
    id: "kleur",
    label: "Kleur",
    base: "/openfreemap-base.json",
    thumb: "/basemap-thumb-kleur.png",
    baseId: "kleur",
    options: { labels: false, roads: false },
  },
  {
    // The same base, plus water/roads AND labels drawn again above user data.
    id: "kleur-labels",
    label: "Kleur met labels en wegen",
    base: "/openfreemap-base.json",
    overlay: "/openfreemap-roads-labels.json",
    thumb: "/basemap-thumb-kleur-labels.png",
    baseId: "kleur",
    options: { labels: true, roads: true },
  },
  {
    id: "kleur-labels-only",
    label: "Kleur met labels",
    base: "/openfreemap-base.json",
    overlay: "/openfreemap-labels.json",
    thumb: "/basemap-thumb-kleur-labels.png",
    baseId: "kleur",
    options: { labels: true, roads: false },
  },
  {
    id: "kleur-wegen",
    label: "Kleur met wegen",
    base: "/openfreemap-base.json",
    overlay: "/openfreemap-roads.json",
    thumb: "/basemap-thumb-kleur.png",
    baseId: "kleur",
    options: { labels: false, roads: true },
  },
  {
    id: "grijs",
    label: "Grijs",
    base: "/positron-base.json",
    thumb: "/basemap-thumb-grijs.png",
    baseId: "grijs",
    options: { labels: false, roads: false },
  },
  {
    // Positron's own roads, but the Kleur label layers: positron's light grey
    // text was unreadable over most data layers.
    id: "grijs-labels",
    label: "Grijs met labels en wegen",
    base: "/positron-base.json",
    overlay: "/positron-roads-labels.json",
    thumb: "/basemap-thumb-grijs-labels.png",
    baseId: "grijs",
    options: { labels: true, roads: true },
  },
  {
    // Shares Kleur's label overlay outright — same reason as grijs-labels.
    id: "grijs-labels-only",
    label: "Grijs met labels",
    base: "/positron-base.json",
    overlay: "/openfreemap-labels.json",
    thumb: "/basemap-thumb-grijs-labels.png",
    baseId: "grijs",
    options: { labels: true, roads: false },
  },
  {
    id: "grijs-wegen",
    label: "Grijs met wegen",
    base: "/positron-base.json",
    overlay: "/positron-roads.json",
    thumb: "/basemap-thumb-grijs.png",
    baseId: "grijs",
    options: { labels: false, roads: true },
  },
];

/**
 * Spelled out rather than derived from `BASEMAPS[0]`: the array is grouped by base
 * and may be rearranged, which must not silently move the default.
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
 * The basemap id for a base plus a set of ticked options.
 *
 * An option a base does not support is ignored rather than treated as no match, so
 * asking for Luchtfoto with "roads" set resolves to plain Luchtfoto instead of
 * failing. Falls back to the base's no-options entry, which every base has.
 */
export function basemapIdFor(baseId: BasemapBaseId, options: BasemapOptions): string {
  const supports = BASEMAP_BASES.find((b) => b.id === baseId)?.supports ?? [];
  const wanted: BasemapOptions = {
    labels: supports.includes("labels") && options.labels,
    roads: supports.includes("roads") && options.roads,
  };
  const match = BASEMAPS.find(
    (b) =>
      b.baseId === baseId &&
      b.options.labels === wanted.labels &&
      b.options.roads === wanted.roads,
  );
  if (match) return match.id;
  console.warn(`No basemap for "${baseId}" with ${JSON.stringify(wanted)}; using its plain variant`);
  return basemapPlainId(baseId);
}

/** The no-options entry for a base. */
function basemapPlainId(baseId: BasemapBaseId): string {
  const plain = BASEMAPS.find(
    (b) => b.baseId === baseId && !b.options.labels && !b.options.roads,
  );
  return plain?.id ?? DEFAULT_BASEMAP_ID;
}

/**
 * The base and ticked options behind a basemap id — the inverse of basemapIdFor,
 * used by the picker to render its circles and checkboxes from the single id the
 * rest of the app carries. An unknown id resolves through basemapById, so it
 * reports the default basemap's combination rather than an empty one.
 */
export function basemapOptionsOf(id: string): {
  baseId: BasemapBaseId;
  options: BasemapOptions;
} {
  const basemap = basemapById(id);
  return { baseId: basemap.baseId, options: { ...basemap.options } };
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

