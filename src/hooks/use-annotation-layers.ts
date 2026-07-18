import { useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { hexToRgba } from "@/lib/collab-identity";
import { distanceMeters, metersPerPixel, METERS_PER_DEGREE_LAT } from "@/lib/geo";
import type { Annotation, CollabPresence } from "@/types/annotation";
import type { AnnotationDraft } from "@/hooks/use-annotation-tool";

/** Datum for the selected polygon's pickable edge/vertex handle layers. */
export interface PolygonHandleDatum {
  annotation: Annotation;
  /** Vertex index; for an edge, the index of its start vertex. */
  index: number;
}

const FONT_FAMILY = "'Geist Variable', system-ui, sans-serif";
const CURSOR_ICON = {
  url: "/cursor-arrow.svg",
  width: 24,
  height: 24,
  // Anchor at the arrow tip so the icon points at the peer's exact position.
  anchorX: 5,
  anchorY: 3,
  mask: true,
} as const;
// The material "location_on" pin, anchored at its tip (the marked position).
const PIN_ICON = {
  url: "/location-pin.svg",
  width: 24,
  height: 24,
  anchorX: 12,
  anchorY: 22,
  mask: true,
} as const;
/** On-map pin icon height in pixels; selected/highlighted pins render larger
 * (exported: App anchors the selected pin's title box above the icon). */
const PIN_SIZE_PX = 32;
export const PIN_SIZE_ACTIVE_PX = 38;
// Far-zoom icon forms of circle/polygon annotations (toolbar icon shapes),
// anchored at their center like the toolbar glyphs.
const CIRCLE_ICON = {
  url: "/annotation-circle.svg",
  width: 24,
  height: 24,
  mask: true,
} as const;
const POLYGON_ICON = {
  url: "/annotation-polygon.svg",
  width: 24,
  height: 24,
  mask: true,
} as const;
/** Screen radius below which a circle/polygon collapses to its icon form. */
const ICONIFY_RADIUS_PX = 12;

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

export interface AnnotationLayersOptions {
  annotations: Annotation[];
  /** In-progress circle while drawing (from the annotation tool). */
  draft: AnnotationDraft | null;
  /** Locally selected annotation — rendered with an emphasized ring. */
  selectedId: string | null;
  /** Remote participants (live cursors + their selection highlights). */
  peers: CollabPresence[];
  /** Local identity color (tints the draft circle). */
  identityColor: string;
  /** False hides everything (annotation mode off). */
  visible: boolean;
  /** Current map zoom — decides which shapes collapse to their icon form. */
  zoom: number;
  /** "a" | "b" — layer ids must differ per map (two Deck overlays). */
  suffix: string;
}

/**
 * Deck.gl layers for the annotation tool, loaded through the `topLayers`
 * channel (pinned above data + labels), mirroring useSelectionBoxLayers.
 * Call once per map — Layer instances must not be shared across two Deck
 * overlays. Both maps share the viewState, so peer cursors and circles are
 * geographically consistent on A and B.
 */
export function useAnnotationLayers({
  annotations,
  draft,
  selectedId,
  peers,
  identityColor,
  visible,
  zoom,
  suffix,
}: AnnotationLayersOptions): Layer[] {
  // Annotations highlighted for anyone: the local selection plus every peer's
  // broadcast selection (shows collaborators what others are looking at).
  const activeIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedId) ids.add(selectedId);
    for (const peer of peers) {
      if (peer.activeAnnotationId) ids.add(peer.activeAnnotationId);
    }
    return ids;
  }, [selectedId, peers]);

  return useMemo(() => {
    if (!visible) return [];
    const activeKey = [...activeIds].sort().join(",");
    // Shapes too small on screen at this zoom render as icons instead.
    const iconified = new Set(
      annotations.filter((a) => isAnnotationIconified(a, zoom)).map((a) => a.id),
    );
    const iconifiedKey = [...iconified].sort().join(",");
    const circles = annotations.filter(
      (a) => !a.points && !a.pin && !iconified.has(a.id),
    );
    const polygons = annotations.filter((a) => a.points && !iconified.has(a.id));
    const pins = annotations.filter((a) => a.pin);
    const shapeIcons = annotations.filter((a) => iconified.has(a.id));
    const layers: Layer[] = [
      new PolygonLayer<Annotation>({
        id: `annotations-polygons-${suffix}`,
        data: polygons,
        pickable: true,
        stroked: true,
        filled: true,
        getPolygon: (d) => d.points!.map((p) => [p.lng, p.lat]),
        getFillColor: (d) => hexToRgba(d.color, 30),
        getLineColor: (d) => hexToRgba(d.color, activeIds.has(d.id) ? 255 : 200),
        getLineWidth: (d) => (activeIds.has(d.id) ? 3.5 : 2),
        lineWidthUnits: "pixels",
        updateTriggers: {
          getLineColor: activeKey,
          getLineWidth: activeKey,
        },
      }),
      new ScatterplotLayer<Annotation>({
        id: `annotations-circles-${suffix}`,
        data: circles,
        pickable: true,
        stroked: true,
        filled: true,
        radiusUnits: "meters",
        getPosition: (d) => [d.center.lng, d.center.lat],
        getRadius: (d) => d.radiusM,
        getFillColor: (d) => hexToRgba(d.color, 30),
        getLineColor: (d) => hexToRgba(d.color, activeIds.has(d.id) ? 255 : 200),
        getLineWidth: (d) => (activeIds.has(d.id) ? 3.5 : 2),
        lineWidthUnits: "pixels",
        updateTriggers: {
          getLineColor: activeKey,
          getLineWidth: activeKey,
        },
      }),
      new IconLayer<Annotation>({
        id: `annotations-pins-${suffix}`,
        data: pins,
        pickable: true,
        // Keep the glyph's transparent cutout pickable, not a click hole.
        alphaCutoff: 0,
        getPosition: (d) => [d.center.lng, d.center.lat],
        getIcon: () => ({ id: "location-pin", ...PIN_ICON }),
        getSize: (d) => (activeIds.has(d.id) ? PIN_SIZE_ACTIVE_PX : PIN_SIZE_PX),
        sizeUnits: "pixels",
        getColor: (d) => hexToRgba(d.color, 255),
        billboard: true,
        updateTriggers: {
          getSize: activeKey,
        },
      }),
      new IconLayer<Annotation>({
        id: `annotations-shape-icons-${suffix}`,
        data: shapeIcons,
        pickable: true,
        // The glyphs are outlines — without this, their transparent interior
        // is a picking hole and clicks through the middle miss the icon.
        alphaCutoff: 0,
        getPosition: (d) => [d.center.lng, d.center.lat],
        getIcon: (d) =>
          d.points
            ? { id: "annotation-polygon", ...POLYGON_ICON }
            : { id: "annotation-circle", ...CIRCLE_ICON },
        getSize: (d) => (activeIds.has(d.id) ? PIN_SIZE_ACTIVE_PX : PIN_SIZE_PX),
        sizeUnits: "pixels",
        getColor: (d) => hexToRgba(d.color, 255),
        billboard: true,
        updateTriggers: {
          getSize: activeKey,
        },
      }),
      new TextLayer<Annotation>({
        id: `annotations-labels-${suffix}`,
        // The locally selected annotation shows its title in the floating
        // titlebox instead — skip its map label to avoid doubling it.
        data: annotations.filter((d) => d.title && d.id !== selectedId),
        pickable: false,
        // Titles sit above their shape: circles above the rim, polygons above
        // the topmost vertex (north-up is guaranteed — rotation is disabled);
        // pins and iconified shapes label above their center-anchored icon.
        getPosition: (d) => {
          if (d.pin || iconified.has(d.id)) return [d.center.lng, d.center.lat];
          if (d.points) {
            return [d.center.lng, Math.max(...d.points.map((p) => p.lat))];
          }
          return [d.center.lng, d.center.lat + d.radiusM / METERS_PER_DEGREE_LAT];
        },
        getText: (d) => d.title,
        getSize: 13,
        sizeUnits: "pixels",
        fontFamily: FONT_FAMILY,
        characterSet: "auto",
        getColor: [40, 40, 40, 255],
        background: true,
        getBackgroundColor: [255, 255, 255, 220],
        backgroundPadding: [6, 3, 6, 3],
        // Pins and iconified shapes extend upward/outward from their anchor —
        // lift their label clear of the icon.
        getPixelOffset: (d) =>
          d.pin
            ? [0, -(PIN_SIZE_ACTIVE_PX + 8)]
            : iconified.has(d.id)
              ? [0, -(PIN_SIZE_ACTIVE_PX / 2 + 8)]
              : [0, -14],
        billboard: true,
        updateTriggers: {
          getPixelOffset: iconifiedKey,
          getPosition: iconifiedKey,
        },
      }),
    ];

    // Edit handles for the locally selected polygon (Figma-style): pickable
    // per-edge segments (mousedown on one splits it) drawn over the polygon's
    // own stroke in the same opaque style, and draggable corner handles.
    const selectedPolygon = polygons.find((a) => a.id === selectedId);
    if (selectedPolygon?.points) {
      const pts = selectedPolygon.points;
      const edges: Array<PolygonHandleDatum & { path: [number, number][] }> =
        pts.map((p, i) => {
          const q = pts[(i + 1) % pts.length];
          return {
            annotation: selectedPolygon,
            index: i,
            path: [
              [p.lng, p.lat],
              [q.lng, q.lat],
            ],
          };
        });
      const vertices: Array<PolygonHandleDatum & { position: [number, number] }> =
        pts.map((p, i) => ({
          annotation: selectedPolygon,
          index: i,
          position: [p.lng, p.lat],
        }));
      layers.push(
        new PathLayer<(typeof edges)[number]>({
          id: `annotations-edges-${suffix}`,
          data: edges,
          pickable: true,
          getPath: (d) => d.path,
          getColor: hexToRgba(selectedPolygon.color, 255),
          getWidth: 3.5,
          widthUnits: "pixels",
        }),
        new ScatterplotLayer<(typeof vertices)[number]>({
          id: `annotations-vertices-${suffix}`,
          data: vertices,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          getPosition: (d) => d.position,
          getRadius: 5,
          getFillColor: [255, 255, 255, 255],
          getLineColor: hexToRgba(selectedPolygon.color, 255),
          getLineWidth: 1.5,
          lineWidthUnits: "pixels",
        }),
      );
    }

    if (draft?.kind === "circle") {
      layers.push(
        new ScatterplotLayer<AnnotationDraft & { kind: "circle" }>({
          id: `annotations-draft-${suffix}`,
          data: [draft],
          pickable: false,
          stroked: true,
          filled: true,
          radiusUnits: "meters",
          getPosition: (d) => [d.center.lng, d.center.lat],
          getRadius: (d) => d.radiusM,
          getFillColor: hexToRgba(identityColor, 15),
          getLineColor: hexToRgba(identityColor, 180),
          getLineWidth: 2,
          lineWidthUnits: "pixels",
        }),
      );
    } else if (draft?.kind === "polygon") {
      layers.push(
        new PolygonLayer<AnnotationDraft & { kind: "polygon" }>({
          id: `annotations-draft-${suffix}`,
          data: [draft],
          pickable: false,
          stroked: true,
          filled: true,
          getPolygon: (d) => d.points.map((p) => [p.lng, p.lat]),
          getFillColor: hexToRgba(identityColor, 15),
          getLineColor: hexToRgba(identityColor, 180),
          getLineWidth: 2,
          lineWidthUnits: "pixels",
        }),
      );
    }

    const cursors = peers.filter(
      (p): p is CollabPresence & { cursor: { lng: number; lat: number } } =>
        p.cursor !== null,
    );
    if (cursors.length > 0) {
      layers.push(
        new IconLayer<(typeof cursors)[number]>({
          id: `annotations-cursors-${suffix}`,
          data: cursors,
          pickable: false,
          getPosition: (d) => [d.cursor.lng, d.cursor.lat],
          getIcon: () => ({ id: "cursor-arrow", ...CURSOR_ICON }),
          getSize: 20,
          sizeUnits: "pixels",
          getColor: (d) => hexToRgba(d.user.color, 255),
          billboard: true,
        }),
        new TextLayer<(typeof cursors)[number]>({
          id: `annotations-cursor-names-${suffix}`,
          data: cursors,
          pickable: false,
          getPosition: (d) => [d.cursor.lng, d.cursor.lat],
          getText: (d) => d.user.name,
          getSize: 11,
          sizeUnits: "pixels",
          fontFamily: FONT_FAMILY,
          characterSet: "auto",
          getColor: [255, 255, 255, 255],
          background: true,
          getBackgroundColor: (d) => hexToRgba(d.user.color, 230),
          backgroundPadding: [5, 2, 5, 2],
          getPixelOffset: [14, 18],
          getTextAnchor: "start",
          billboard: true,
        }),
      );
    }

    return layers;
  }, [visible, annotations, draft, activeIds, selectedId, peers, identityColor, zoom, suffix]);
}
