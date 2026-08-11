import { useCallback, useRef } from "react";
import type { MapViewHandle } from "@/components/map/MapView";
import type { Annotation } from "@/types/annotation";
import type { AnnotationsState } from "./use-annotations";
import type { CollabIdentity } from "@/lib/collab-identity";
import type { AreaFilterState } from "./use-area-filter";
import type { UseMapLayersResult } from "./use-map-layers";
import type { AnnotationHit } from "./use-annotation-tool";
import type { ViewState } from "@/components/map/MapView";
import { ANNOT_LAYERS, annotationKind } from "@/layers/annotation-style";
import { restoreSnapshot } from "@/lib/annotation-restore";
import { isUrlAddressable } from "@/lib/share-url";
import { selectionsToJson, type AnnotationSnapshot } from "@/types/annotation";
import { centroid } from "@/lib/geo";

/**
 * The annotation write + pick operations, i.e. everything `useAnnotationTool`
 * needs to drive a gesture.
 *
 * Split out of App because these are self-contained: each one either builds an
 * Annotation, forwards an update to the Yjs-backed store, restores a snapshot,
 * or queries the map. App keeps the parts that interleave with rendering —
 * selection state, the popup anchor, and the pointer dispatch that fans a click
 * out across annotations, box-select, feature-pick and Street View.
 */
export interface UseAnnotationCommandsOptions {
  annotations: AnnotationsState;
  identity: CollabIdentity;
  /** Snapshot inputs: what an annotation restores when clicked. */
  areaFilter: AreaFilterState;
  mapLeftLayers: UseMapLayersResult;
  mapRightLayers: UseMapLayersResult;
  viewState: ViewState;
  mapLeftRef: React.RefObject<MapViewHandle | null>;
  mapRightRef: React.RefObject<MapViewHandle | null>;
  /**
   * App's live mirror of `areaFilter`. Shared rather than mirrored again here
   * because the host-filter bridge reads the same ref.
   */
  areaFilterRef: React.RefObject<AreaFilterState>;
}

export interface UseAnnotationCommandsResult {
  createCircle: (center: { lng: number; lat: number }, radiusM: number) => string;
  createPolygon: (points: Array<{ lng: number; lat: number }>) => string;
  createPin: (center: { lng: number; lat: number }) => string;
  move: (id: string, center: { lng: number; lat: number }) => void;
  editPoints: (
    id: string,
    points: Array<{ lng: number; lat: number }>,
    center: { lng: number; lat: number },
  ) => void;
  resize: (id: string, radiusM: number) => void;
  restore: (id: string) => void;
  pickAt: (side: "a" | "b", point: { x: number; y: number }) => AnnotationHit | null;
  /** Also used by the edit popup's "re-capture" action. */
  captureSnapshot: () => AnnotationSnapshot;
}

export function useAnnotationCommands({
  annotations,
  identity,
  areaFilter,
  mapLeftLayers,
  mapRightLayers,
  viewState,
  mapLeftRef,
  mapRightRef,
  areaFilterRef,
}: UseAnnotationCommandsOptions): UseAnnotationCommandsResult {
  // Live refs for the async snapshot restore: layer adds await full data loads,
  // so state objects captured at click time go stale mid-run.
  /* eslint-disable react-hooks/refs -- deliberate latest-value mirrors */
  const mapLeftLayersRef = useRef(mapLeftLayers);
  mapLeftLayersRef.current = mapLeftLayers;
  const mapRightLayersRef = useRef(mapRightLayers);
  mapRightLayersRef.current = mapRightLayers;
  const annotationListRef = useRef(annotations.annotations);
  annotationListRef.current = annotations.annotations;
  /* eslint-enable react-hooks/refs */
  const restoreTokenRef = useRef(0);

  // Everything an annotation restores: filter selections, both sides'
  // (URL-addressable) layer ids + hidden ids, and the camera.
  const captureSnapshot = useCallback(
    (): AnnotationSnapshot => ({
      areaFilterSelections: selectionsToJson(areaFilter.selections),
      mapA: {
        layerIds: mapLeftLayers.layerEntries
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...mapLeftLayers.hiddenIds],
      },
      mapB: {
        layerIds: mapRightLayers.layerEntries
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...mapRightLayers.hiddenIds],
      },
      view: {
        longitude: viewState.longitude,
        latitude: viewState.latitude,
        zoom: viewState.zoom,
      },
    }),
    [areaFilter.selections, mapLeftLayers, mapRightLayers, viewState],
  );

  // The fields every new annotation shares, whatever its shape.
  const newAnnotationBase = useCallback(
    () => ({
      id: crypto.randomUUID(),
      title: "",
      description: "",
      color: identity.color,
      author: identity.name,
      createdAt: Date.now(),
      snapshot: captureSnapshot(),
    }),
    [identity, captureSnapshot],
  );

  const createCircle = useCallback(
    (center: { lng: number; lat: number }, radiusM: number): string => {
      const annotation: Annotation = { ...newAnnotationBase(), center, radiusM };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, newAnnotationBase],
  );

  const createPolygon = useCallback(
    (points: Array<{ lng: number; lat: number }>): string => {
      const annotation: Annotation = {
        ...newAnnotationBase(),
        center: centroid(points),
        radiusM: 0,
        points,
      };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, newAnnotationBase],
  );

  const createPin = useCallback(
    (center: { lng: number; lat: number }): string => {
      const annotation: Annotation = {
        ...newAnnotationBase(),
        center,
        radiusM: 0,
        pin: true,
      };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, newAnnotationBase],
  );

  const move = useCallback(
    (id: string, center: { lng: number; lat: number }) => {
      annotations.update(id, { center });
    },
    [annotations],
  );

  const editPoints = useCallback(
    (
      id: string,
      points: Array<{ lng: number; lat: number }>,
      center: { lng: number; lat: number },
    ) => {
      annotations.update(id, { points, center });
    },
    [annotations],
  );

  const resize = useCallback(
    (id: string, radiusM: number) => {
      annotations.update(id, { radiusM });
    },
    [annotations],
  );

  // Plain click on a circle: bring the session back to the annotation's
  // snapshot. Local-only — peers' maps don't move.
  const restore = useCallback(
    (id: string) => {
      const annotation = annotationListRef.current.find((a) => a.id === id);
      if (!annotation) return;
      const token = ++restoreTokenRef.current;
      void restoreSnapshot(
        annotation.snapshot,
        {
          applySelections: (next) => areaFilterRef.current.applySelections(next),
          getSideA: () => ({
            layers: mapLeftLayersRef.current,
            mapRef: mapLeftRef.current?.mapRef ?? { current: null },
          }),
          getSideB: () => ({
            layers: mapRightLayersRef.current,
            mapRef: mapRightRef.current?.mapRef ?? { current: null },
          }),
        },
        () => restoreTokenRef.current !== token,
      );
    },
    [areaFilterRef, mapLeftRef, mapRightRef],
  );

  // Synchronous pick against a side's annotation layers, deciding at mousedown
  // what the gesture edits. Handles (vertices, then edges) win over shape
  // bodies, with a wider pick box so they're easy to grab.
  //
  // `queryRenderedFeatures` takes a point or a BOX, never deck's radius — so a
  // radius becomes a square, marginally more permissive at the corners. It also
  // only returns features that actually DREW: the annotation layers set
  // `icon-allow-overlap` / `text-ignore-placement` so MapLibre's collision
  // engine can never cull a symbol out of pickability (deck's layers had no
  // collision detection at all, so everything was always pickable).
  const pickAt = useCallback(
    (side: "a" | "b", point: { x: number; y: number }): AnnotationHit | null => {
      const map = (side === "a" ? mapLeftRef.current : mapRightRef.current)
        ?.mapRef.current?.getMap();
      if (!map) return null;

      const query = (layerIds: string[], radius: number) => {
        const present = layerIds.filter((id) => map.getLayer(id));
        if (present.length === 0) return [];
        return map.queryRenderedFeatures(
          [
            [point.x - radius, point.y - radius],
            [point.x + radius, point.y + radius],
          ],
          { layers: present },
        );
      };
      // MapLibre carries no datum, so features reference their annotation by
      // id and it is resolved against the live list.
      const byId = (id: unknown): Annotation | null =>
        annotationListRef.current.find((a) => a.id === id) ?? null;

      const vertex = query([ANNOT_LAYERS.vertices], 6)[0];
      if (vertex) {
        const annotation = byId(vertex.properties?.annotationId);
        if (annotation) {
          return { type: "vertex", annotation, index: Number(vertex.properties?.index) };
        }
      }
      const edge = query([ANNOT_LAYERS.edges], 4)[0];
      if (edge) {
        const annotation = byId(edge.properties?.annotationId);
        if (annotation) {
          return { type: "edge", annotation, index: Number(edge.properties?.index) };
        }
      }

      const body = query(
        [ANNOT_LAYERS.icons, ANNOT_LAYERS.shapesFill, ANNOT_LAYERS.shapesLine],
        2,
      )[0];
      if (body) {
        const annotation = byId(body.properties?.annotationId);
        if (annotation) {
          // The icon layer carries pins AND iconified shapes; `pin` is what
          // distinguishes them (deck used separate layers for the same split).
          if (body.layer?.id === ANNOT_LAYERS.icons && !annotation.pin) {
            return { type: "icon", annotation };
          }
          return { type: annotationKind(annotation), annotation };
        }
      }
      return null;
    },
    [mapLeftRef, mapRightRef],
  );

  return {
    createCircle,
    createPolygon,
    createPin,
    move,
    editPoints,
    resize,
    restore,
    pickAt,
    captureSnapshot,
  };
}
