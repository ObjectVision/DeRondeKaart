import { createEffect, createMemo, type Accessor } from "solid-js";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapViewHandle } from "@/components/map/map-view-config";
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

/**
 * Every field is an accessor: the redraw effect below then tracks exactly the
 * ones it reads. React had to list them by hand and suppress
 * `exhaustive-deps`, because callers build this object inline and depending on
 * the object itself redrew ~60x/sec while panning.
 */
export interface AnnotationSourceOptions {
  annotations: Accessor<Annotation[]>;
  /** In-progress shape while drawing (from the annotation tool). */
  draft: Accessor<AnnotationDraft | null>;
  /** Locally selected annotation — rendered with an emphasized ring. */
  selectedId: Accessor<string | null>;
  /** Remote participants (live cursors + their selection highlights). */
  peers: Accessor<CollabPresence[]>;
  /** Local identity color (tints the draft shape). */
  identityColor: Accessor<string>;
  /** False hides everything (annotation mode off). */
  visible: Accessor<boolean>;
  /** Current map zoom — decides which shapes collapse to their icon form. */
  zoom: Accessor<number>;
  /**
   * Render the on-map title labels (default true). The PNG export turns them
   * off — it draws titles as callout labels below the circle instead.
   */
  showLabels?: Accessor<boolean>;
  /**
   * Supersampling factor for the sprite images (default 4). Registered as
   * MapLibre's `pixelRatio`, so a hi-res capture rasterizes sharper textures
   * without changing the drawn size.
   */
  iconScale?: Accessor<number>;
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
  mapView: Accessor<MapViewHandle | null>,
  options: AnnotationSourceOptions,
): { resync: () => void } {
  // Annotations highlighted for anyone: the local selection plus every peer's
  // broadcast selection (shows collaborators what others are looking at).
  const activeIds = createMemo(() => {
    const ids = new Set<string>();
    const selected = options.selectedId();
    if (selected) ids.add(selected);
    for (const peer of options.peers()) {
      if (peer.activeAnnotationId) ids.add(peer.activeAnnotationId);
    }
    return ids;
  });

  function draw() {
    // EVERY accessor is read up front, before the guards below can return.
    // A Solid effect subscribes only to what it actually read on its last run:
    // bailing out early on a not-yet-loaded style would leave the effect
    // tracking the map alone, and enabling annotation mode afterwards would
    // then never re-run it — the overlay stayed empty for the whole session.
    // (React's dependency array made the order irrelevant; here it is the
    // difference between working and silently dead.)
    const map = mapView()?.map();
    const visible = options.visible();
    const annotations = options.annotations();
    const draft = options.draft();
    const selectedId = options.selectedId();
    const peers = options.peers();
    const identityColor = options.identityColor();
    const zoom = options.zoom();
    const ids = activeIds();
    const showLabels = options.showLabels?.() !== false;
    const iconScale = options.iconScale?.() ?? 4;

    if (!styleReady(map)) return;

    if (!visible) {
      clearAnnotationOverlay(map);
      return;
    }

    // Painting may be deferred behind the sprite load below, so it works from
    // the values captured above rather than re-reading: a change to any of them
    // re-runs this effect and repaints anyway.
    function paint() {
      if (!styleReady(map)) return;
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.shapes,
        SHAPE_LAYERS,
        buildShapeFeatures(annotations, ids, zoom),
      );
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.draft,
        DRAFT_LAYERS,
        buildDraftFeatures(draft, identityColor),
      );
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.icons,
        ICON_LAYERS,
        buildIconFeatures(annotations, ids, zoom),
      );
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.labels,
        LABEL_LAYERS,
        showLabels ? buildLabelFeatures(annotations, selectedId, zoom) : EMPTY_FC,
      );
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.cursors,
        CURSOR_LAYERS,
        buildCursorFeatures(peers),
      );

      // Handles last, so they sit above the shape they belong to.
      const handleColor = selectedAnnotationColor(annotations, selectedId);
      syncGeoJsonOverlay(
        map,
        ANNOT_SOURCES.handles,
        handleLayers(handleColor),
        buildHandleFeatures(annotations, selectedId, zoom),
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
    }

    // Sprite images must exist before addLayer, and loading them is async.
    const loading = registerAnnotationIcons(map, iconScale);
    if (loading) {
      void loading.then(paint);
      return;
    }
    paint();
  }

  createEffect(draw);

  // Fires from a map event, outside any reactive scope; the accessors are read
  // fresh, which is what the React version needed `latestRef` for.
  return { resync: draw };
}
