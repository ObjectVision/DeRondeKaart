import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapViewHandle } from "@/components/map/MapView";
import type { Annotation, CollabPresence } from "@/types/annotation";
import type { AnnotationDraft } from "@/hooks/use-annotation-tool";
import { registerAnnotationIcons } from "@/layers/annotation-icons";
import {
  ANNOT_LAYERS,
  ANNOT_SOURCES,
  CURSOR_LAYERS,
  DRAFT_LAYERS,
  ICON_LAYERS,
  LABEL_LAYERS,
  SHAPE_LAYERS,
  buildCursorFeatures,
  buildDraftFeatures,
  buildHandleFeatures,
  buildIconFeatures,
  buildLabelFeatures,
  buildShapeFeatures,
  handleLayers,
  selectedAnnotationColor,
} from "@/layers/annotation-style";
import {
  EMPTY_FC,
  removeGeoJsonOverlay,
  styleReady,
  syncGeoJsonOverlay,
} from "@/layers/geojson-overlay";

export interface AnnotationSourceOptions {
  annotations: Annotation[];
  /** In-progress shape while drawing (from the annotation tool). */
  draft: AnnotationDraft | null;
  /** Locally selected annotation — rendered with an emphasized ring. */
  selectedId: string | null;
  /** Remote participants (live cursors + their selection highlights). */
  peers: CollabPresence[];
  /** Local identity color (tints the draft shape). */
  identityColor: string;
  /** False hides everything (annotation mode off). */
  visible: boolean;
  /** Current map zoom — decides which shapes collapse to their icon form. */
  zoom: number;
  /**
   * Render the on-map title labels (default true). The PNG export turns them
   * off — it draws titles as callout labels below the circle instead.
   */
  showLabels?: boolean;
  /**
   * Supersampling factor for the sprite images (default 4). Registered as
   * MapLibre's `pixelRatio`, so a hi-res capture rasterizes sharper textures
   * without changing the drawn size.
   */
  iconScale?: number;
}

/** Remove every annotation source/layer from a map. */
function clearAnnotationOverlay(map: MapLibreMap) {
  removeGeoJsonOverlay(map, ANNOT_SOURCES.shapes, [
    ANNOT_LAYERS.shapesFill,
    ANNOT_LAYERS.shapesLine,
  ]);
  removeGeoJsonOverlay(map, ANNOT_SOURCES.draft, [
    ANNOT_LAYERS.draftFill,
    ANNOT_LAYERS.draftLine,
  ]);
  removeGeoJsonOverlay(map, ANNOT_SOURCES.icons, [ANNOT_LAYERS.icons]);
  removeGeoJsonOverlay(map, ANNOT_SOURCES.labels, [ANNOT_LAYERS.labels]);
  removeGeoJsonOverlay(map, ANNOT_SOURCES.cursors, [ANNOT_LAYERS.cursors]);
  removeGeoJsonOverlay(map, ANNOT_SOURCES.handles, [
    ANNOT_LAYERS.edges,
    ANNOT_LAYERS.vertices,
  ]);
}

/**
 * Draw the annotation overlay (shapes, labels, icons, peer cursors) as
 * MapLibre GeoJSON sources on one map's own style.
 *
 * Unlike the deck.gl layer hook this replaces, nothing is returned to render:
 * each map has its own style, so sources are naturally per-map and there is no
 * "Layer instances must not be shared across overlays" hazard — and no need
 * for a per-map id suffix.
 *
 * Returns a `resync` to re-add everything after a basemap swap (`setStyle()`
 * wipes both the sprite images and the layers); call it from `onLabelsReady`.
 */
export function useAnnotationSource(
  mapViewRef: React.RefObject<MapViewHandle | null>,
  options: AnnotationSourceOptions,
): { resync: () => void } {
  const { selectedId, peers } = options;

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

  // Latest inputs, read by `resync` — which fires from a map event, long after
  // the render that produced them. Written in an effect, never during render.
  const latestRef = useRef({ options, activeIds });

  const draw = useCallback(
    (o: AnnotationSourceOptions, ids: Set<string>) => {
      const map = mapViewRef.current?.mapRef.current?.getMap();
      if (!styleReady(map)) return;

      if (!o.visible) {
        clearAnnotationOverlay(map);
        return;
      }

      const paint = () => {
        if (!styleReady(map)) return;
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.shapes,
          SHAPE_LAYERS,
          buildShapeFeatures(o.annotations, ids, o.zoom),
        );
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.draft,
          DRAFT_LAYERS,
          buildDraftFeatures(o.draft, o.identityColor),
        );
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.icons,
          ICON_LAYERS,
          buildIconFeatures(o.annotations, ids, o.zoom),
        );
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.labels,
          LABEL_LAYERS,
          o.showLabels === false
            ? EMPTY_FC
            : buildLabelFeatures(o.annotations, o.selectedId, o.zoom),
        );
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.cursors,
          CURSOR_LAYERS,
          buildCursorFeatures(o.peers),
        );

        // Handles last, so they sit above the shape they belong to.
        const handleColor = selectedAnnotationColor(o.annotations, o.selectedId);
        syncGeoJsonOverlay(
          map,
          ANNOT_SOURCES.handles,
          handleLayers(handleColor),
          buildHandleFeatures(o.annotations, o.selectedId, o.zoom),
        );
        // The stroke color follows the selection, but the layers already
        // exist by now — syncGeoJsonOverlay only creates missing ones, so the
        // paint has to be pushed separately.
        if (map.getLayer(ANNOT_LAYERS.edges)) {
          map.setPaintProperty(ANNOT_LAYERS.edges, "line-color", handleColor);
        }
        if (map.getLayer(ANNOT_LAYERS.vertices)) {
          map.setPaintProperty(ANNOT_LAYERS.vertices, "circle-stroke-color", handleColor);
        }
      };

      // Sprite images must exist before addLayer, and loading them is async.
      const loading = registerAnnotationIcons(map, o.iconScale ?? 4);
      if (loading) {
        void loading.then(paint);
        return;
      }
      paint();
    },
    [mapViewRef],
  );

  // Redraw on every input change. The dependency list is the individual
  // fields, not the options object — callers build that inline, so it has a
  // new identity every render.
  const {
    annotations,
    draft,
    identityColor,
    visible,
    zoom,
    showLabels,
    iconScale,
  } = options;
  useEffect(() => {
    latestRef.current = { options, activeIds };
    draw(options, activeIds);
    // `options` is intentionally not a dependency: it is rebuilt inline by the
    // caller each render, so depending on it would redraw ~60×/sec while
    // panning. The fields it carries are listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    annotations,
    draft,
    selectedId,
    peers,
    identityColor,
    visible,
    zoom,
    showLabels,
    iconScale,
    activeIds,
    draw,
  ]);

  const resync = useCallback(() => {
    const { options: o, activeIds: ids } = latestRef.current;
    draw(o, ids);
  }, [draw]);

  return useMemo(() => ({ resync }), [resync]);
}
