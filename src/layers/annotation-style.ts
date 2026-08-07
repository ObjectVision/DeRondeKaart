import type { AddLayerObject } from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import type { Annotation, CollabPresence } from "@/types/annotation";
import type { AnnotationDraft } from "@/hooks/use-annotation-tool";
import { distanceMeters, geodesicRing, metersPerPixel, METERS_PER_DEGREE_LAT } from "@/lib/geo";

/**
 * Feature builders and layer specs for the annotation overlay.
 *
 * Pure: everything here maps annotation state to GeoJSON + MapLibre style, with
 * no map access. `use-annotation-source` owns the imperative sync.
 *
 * Design notes carried over from the deck.gl implementation this replaces:
 * - deck encoded "is this annotation active" in a color's alpha channel. Here
 *   `color` (hex) and `active` (boolean) ride as feature properties and the
 *   paint expressions branch on them, which keeps the data readable.
 * - deck's ScatterplotLayer drew circles with `radiusUnits: "meters"`, which
 *   MapLibre has no equivalent for. Circles become geodesic polygons instead,
 *   so circles and polygons share ONE source and one pair of layers.
 */

/** On-map pin icon height in px; selected/highlighted pins render larger. */
export const PIN_SIZE_PX = 32;
export const PIN_SIZE_ACTIVE_PX = 38;
/** Screen radius below which a circle/polygon collapses to its icon form. */
const ICONIFY_RADIUS_PX = 12;
/** The sprite images are registered as 24px logical icons. */
const ICON_BASE_PX = 24;
const LABEL_TEXT_SIZE = 13;

export const ANNOT_SOURCES = {
  shapes: "annot-shapes",
  draft: "annot-draft",
  icons: "annot-icons",
  labels: "annot-labels",
  cursors: "annot-cursors",
  handles: "annot-handles",
} as const;

export const ANNOT_LAYERS = {
  shapesFill: "annot-shapes-fill",
  shapesLine: "annot-shapes-line",
  draftFill: "annot-draft-fill",
  draftLine: "annot-draft-line",
  icons: "annot-icons-symbol",
  labels: "annot-labels-symbol",
  cursors: "annot-cursors-symbol",
  edges: "annot-edges-line",
  vertices: "annot-vertices-circle",
} as const;

/** Sprite ids for the four mask icons; see `annotation-icons.ts`. */
export const ANNOT_ICON_IDS = {
  pin: "annot-pin",
  circle: "annot-circle",
  polygon: "annot-polygon",
  cursor: "annot-cursor",
} as const;

/**
 * True when the shape is too small on screen at this zoom to be drawn as a
 * shape — it renders as a fixed-size icon instead (pins always do).
 */
export function isAnnotationIconified(a: Annotation, zoom: number): boolean {
  if (a.pin) return false;
  const radiusM = a.points
    ? Math.max(...a.points.map((p) => distanceMeters(a.center, p)))
    : a.radiusM;
  return radiusM / metersPerPixel(a.center.lat, zoom) < ICONIFY_RADIUS_PX;
}

/** The ring for an annotation: its polygon points, or a geodesic circle. */
function annotationRing(a: Annotation): [number, number][] {
  if (a.points) {
    const ring = a.points.map((p) => [p.lng, p.lat] as [number, number]);
    // GeoJSON polygons must close; the stored ring is open.
    ring.push(ring[0]);
    return ring;
  }
  return geodesicRing(a.center, a.radiusM);
}

/**
 * Shapes (circles + polygons) as one FeatureCollection. Iconified shapes and
 * pins are excluded — they are drawn by the icon layer instead.
 */
export function buildShapeFeatures(
  annotations: Annotation[],
  activeIds: Set<string>,
  zoom: number,
): FeatureCollection {
  const features: Feature<Polygon>[] = [];
  for (const a of annotations) {
    if (a.pin || isAnnotationIconified(a, zoom)) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [annotationRing(a)] },
      properties: {
        annotationId: a.id,
        kind: a.points ? "polygon" : "circle",
        color: a.color,
        active: activeIds.has(a.id),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The in-progress draft shape (circle or polygon) while drawing. */
export function buildDraftFeatures(
  draft: AnnotationDraft | null,
  identityColor: string,
): FeatureCollection {
  if (!draft) return { type: "FeatureCollection", features: [] };

  const ring: [number, number][] =
    draft.kind === "circle"
      ? geodesicRing(draft.center, draft.radiusM)
      : (() => {
          const pts = draft.points.map((p) => [p.lng, p.lat] as [number, number]);
          // A 1–2 point draft is not a valid polygon; MapLibre would drop it.
          if (pts.length < 3) return [];
          pts.push(pts[0]);
          return pts;
        })();
  if (ring.length === 0) return { type: "FeatureCollection", features: [] };

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { color: identityColor },
      },
    ],
  };
}

/**
 * Pins plus circles/polygons collapsed to their far-zoom icon form, as one
 * symbol source. `icon` selects the sprite; `size` is the drawn height in px.
 */
export function buildIconFeatures(
  annotations: Annotation[],
  activeIds: Set<string>,
  zoom: number,
): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const a of annotations) {
    const iconified = isAnnotationIconified(a, zoom);
    if (!a.pin && !iconified) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.center.lng, a.center.lat] },
      properties: {
        annotationId: a.id,
        icon: a.pin
          ? ANNOT_ICON_IDS.pin
          : a.points
            ? ANNOT_ICON_IDS.polygon
            : ANNOT_ICON_IDS.circle,
        // Pins anchor at their tip; the shape glyphs are centered.
        anchor: a.pin ? "bottom" : "center",
        color: a.color,
        size: (activeIds.has(a.id) ? PIN_SIZE_ACTIVE_PX : PIN_SIZE_PX) / ICON_BASE_PX,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Title labels. Positioned above their shape: circles above the rim, polygons
 * above the topmost vertex (north-up is guaranteed — rotation is disabled),
 * pins and iconified shapes above their center-anchored icon.
 *
 * The locally selected annotation is skipped: its title shows in the floating
 * titlebox instead, and drawing both would double it.
 */
export function buildLabelFeatures(
  annotations: Annotation[],
  selectedId: string | null,
  zoom: number,
): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const a of annotations) {
    if (!a.title || a.id === selectedId) continue;
    const iconified = isAnnotationIconified(a, zoom);

    let position: [number, number];
    if (a.pin || iconified) {
      position = [a.center.lng, a.center.lat];
    } else if (a.points) {
      position = [a.center.lng, Math.max(...a.points.map((p) => p.lat))];
    } else {
      position = [a.center.lng, a.center.lat + a.radiusM / METERS_PER_DEGREE_LAT];
    }

    // deck took a pixel offset; MapLibre's text-offset is in ems.
    const offsetPx = a.pin
      ? -(PIN_SIZE_ACTIVE_PX + 8)
      : iconified
        ? -(PIN_SIZE_ACTIVE_PX / 2 + 8)
        : -14;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: position },
      properties: {
        annotationId: a.id,
        title: a.title,
        offset: [0, offsetPx / LABEL_TEXT_SIZE],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Edit handles for the selected polygon (Figma-style): one feature per edge
 * segment (mousedown on one splits it) and one per corner vertex.
 *
 * Every feature carries `annotationId` + `index` as properties — MapLibre has
 * no `object` datum the way deck's picking did, so the caller resolves the
 * annotation by id. The full annotation is deliberately NOT round-tripped
 * through properties: MapLibre stringifies nested objects, and the tool reads
 * `points`/`center`/`radiusM` as live objects.
 *
 * Returns an empty collection unless the selected annotation is a polygon.
 */
export function buildHandleFeatures(
  annotations: Annotation[],
  selectedId: string | null,
  zoom: number,
): FeatureCollection {
  if (!selectedId) return { type: "FeatureCollection", features: [] };
  const selected = annotations.find((a) => a.id === selectedId);
  // Handles belong to a polygon drawn as a shape; an iconified one has no
  // rim to grab, matching the deck implementation.
  if (!selected?.points || isAnnotationIconified(selected, zoom)) {
    return { type: "FeatureCollection", features: [] };
  }

  const pts = selected.points;
  const features: Feature[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [p.lng, p.lat],
          [q.lng, q.lat],
        ],
      },
      properties: { annotationId: selected.id, index: i, handle: "edge" },
    });
  }
  for (let i = 0; i < pts.length; i++) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pts[i].lng, pts[i].lat] },
      properties: { annotationId: selected.id, index: i, handle: "vertex" },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The selected polygon's color, for the handle layers' paint. */
export function selectedAnnotationColor(
  annotations: Annotation[],
  selectedId: string | null,
): string {
  return annotations.find((a) => a.id === selectedId)?.color ?? "#00498D";
}

/** Live peer cursors: the arrow glyph plus the peer's name. */
export function buildCursorFeatures(peers: CollabPresence[]): FeatureCollection {
  const features: Feature<Point>[] = [];
  for (const p of peers) {
    if (!p.cursor) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.cursor.lng, p.cursor.lat] },
      properties: { name: p.user.name, color: p.user.color },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Layer specs
// ---------------------------------------------------------------------------

/**
 * `*-allow-overlap` / `*-ignore-placement` are NOT cosmetic here.
 * `queryRenderedFeatures` only returns symbols that actually drew, so a
 * collision-dropped icon becomes unclickable — and deck's layers had no
 * collision detection at all, so every annotation always drew and was always
 * pickable. Keeping placement unconditional preserves that.
 */
const ALWAYS_PLACE = {
  "icon-allow-overlap": true,
  "icon-ignore-placement": true,
  "text-allow-overlap": true,
  "text-ignore-placement": true,
} as const;

export const SHAPE_LAYERS: AddLayerObject[] = [
  {
    id: ANNOT_LAYERS.shapesFill,
    type: "fill",
    source: ANNOT_SOURCES.shapes,
    paint: {
      "fill-color": ["get", "color"],
      // deck used alpha 30/255 over the annotation's own color.
      "fill-opacity": 30 / 255,
    },
  } as AddLayerObject,
  {
    id: ANNOT_LAYERS.shapesLine,
    type: "line",
    source: ANNOT_SOURCES.shapes,
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": ["case", ["get", "active"], 1, 200 / 255],
      "line-width": ["case", ["get", "active"], 3.5, 2],
    },
  } as AddLayerObject,
];

export const DRAFT_LAYERS: AddLayerObject[] = [
  {
    id: ANNOT_LAYERS.draftFill,
    type: "fill",
    source: ANNOT_SOURCES.draft,
    paint: { "fill-color": ["get", "color"], "fill-opacity": 15 / 255 },
  } as AddLayerObject,
  {
    id: ANNOT_LAYERS.draftLine,
    type: "line",
    source: ANNOT_SOURCES.draft,
    paint: {
      "line-color": ["get", "color"],
      "line-opacity": 180 / 255,
      "line-width": 2,
    },
  } as AddLayerObject,
];

export const ICON_LAYERS: AddLayerObject[] = [
  {
    id: ANNOT_LAYERS.icons,
    type: "symbol",
    source: ANNOT_SOURCES.icons,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["get", "size"],
      "icon-anchor": ["get", "anchor"],
      ...ALWAYS_PLACE,
    },
    // Only SDF images honour icon-color; annotation-icons registers them as SDF.
    paint: { "icon-color": ["get", "color"] },
  } as AddLayerObject,
];

/**
 * Title labels with a white pill behind them.
 *
 * deck's TextLayer had `background: true` + `backgroundPadding`, which MapLibre
 * has no direct equivalent for. A stretchable SDF box image with
 * `icon-text-fit` reproduces it exactly: the image stretches to the text's box
 * and the padding maps 1:1 (note MapLibre's order is top,right,bottom,left
 * against deck's left,top,right,bottom). A plain `text-halo` was the
 * alternative but reads noticeably worse over the aerial basemap.
 */
export const LABEL_LAYERS: AddLayerObject[] = [
  {
    id: ANNOT_LAYERS.labels,
    type: "symbol",
    source: ANNOT_SOURCES.labels,
    layout: {
      "text-field": ["get", "title"],
      "text-size": LABEL_TEXT_SIZE,
      "text-offset": ["get", "offset"],
      "text-font": ["Noto Sans Regular"],
      "icon-image": "annot-label-box",
      "icon-text-fit": "both",
      "icon-text-fit-padding": [3, 6, 3, 6],
      ...ALWAYS_PLACE,
    },
    paint: {
      "text-color": "#282828",
      "icon-color": "#ffffff",
      "icon-opacity": 220 / 255,
    },
  } as AddLayerObject,
];

/**
 * Edit handles for the selected polygon. Drawn over the polygon's own stroke
 * in the same opaque style, with draggable white corner dots.
 *
 * `handleLayers` is a function rather than a constant because the stroke color
 * follows the selected annotation, and MapLibre paint properties are resolved
 * at addLayer time (the color is not a feature property here — every handle in
 * the source belongs to the one selected polygon).
 */
export function handleLayers(color: string): AddLayerObject[] {
  return [
    {
      id: ANNOT_LAYERS.edges,
      type: "line",
      source: ANNOT_SOURCES.handles,
      filter: ["==", ["get", "handle"], "edge"],
      paint: { "line-color": color, "line-width": 3.5 },
    } as AddLayerObject,
    {
      id: ANNOT_LAYERS.vertices,
      type: "circle",
      source: ANNOT_SOURCES.handles,
      filter: ["==", ["get", "handle"], "vertex"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ffffff",
        "circle-stroke-color": color,
        "circle-stroke-width": 1.5,
      },
    } as AddLayerObject,
  ];
}

/** Peer cursors: the arrow glyph, with the peer's name on a tinted pill. */
export const CURSOR_LAYERS: AddLayerObject[] = [
  {
    id: ANNOT_LAYERS.cursors,
    type: "symbol",
    source: ANNOT_SOURCES.cursors,
    layout: {
      "icon-image": ANNOT_ICON_IDS.cursor,
      "icon-size": 20 / ICON_BASE_PX,
      // Anchor at the arrow tip so it points at the peer's exact position.
      "icon-anchor": "top-left",
      "text-field": ["get", "name"],
      "text-size": 11,
      "text-font": ["Noto Sans Regular"],
      "text-anchor": "left",
      "text-offset": [1.3, 1.6],
      ...ALWAYS_PLACE,
    },
    paint: {
      "icon-color": ["get", "color"],
      "text-color": "#ffffff",
      "text-halo-color": ["get", "color"],
      "text-halo-width": 2,
    },
  } as AddLayerObject,
];
