import type { Accessor } from "solid-js";
import type {
  MapViewHandle,
  ViewState,
} from "@/components/map/map-view-config";
import type { Annotation } from "@/types/annotation";
import type { AnnotationsState } from "./use-annotations";
import type { CollabIdentity } from "@/lib/collab-identity";
import type { AreaFilterState } from "./use-area-filter";
import type { UseMapLayersResult } from "./use-map-layers";
import type { AnnotationHit } from "./use-annotation-tool";
import { ANNOT_LAYERS, annotationKind } from "@/layers/annotation-style";
import { restoreSnapshot } from "@/lib/annotation-restore";
import { isUrlAddressable } from "@/lib/share-url";
import { selectionsToJson, type AnnotationSnapshot } from "@/types/annotation";
import { centroid } from "@/lib/geo";
import type { MapSideId } from "@/lib/map-side";

/**
 * The annotation write + pick operations, i.e. everything `useAnnotationTool`
 * needs to drive a gesture.
 *
 * Split out of App because these are self-contained: each one either builds an
 * Annotation, forwards an update to the Yjs-backed store, restores a snapshot,
 * or queries the map. App keeps the parts that interleave with rendering —
 * selection state, the popup anchor, and the pointer dispatch that fans a click
 * out across annotations, box-select, feature-pick and Street View.
 *
 * Everything here reads its inputs through accessors at call time, so the
 * latest-value refs the React version carried (one each for the two sides'
 * layers and for the annotation list, all three flagged with an
 * `eslint-disable react-hooks/refs`) are gone.
 */
export interface UseAnnotationCommandsOptions {
  annotations: AnnotationsState;
  identity: CollabIdentity;
  /** Snapshot inputs: what an annotation restores when clicked. */
  areaFilter: AreaFilterState;
  mapLeftLayers: UseMapLayersResult;
  mapRightLayers: UseMapLayersResult;
  viewState: Accessor<ViewState>;
  mapLeft: Accessor<MapViewHandle | null>;
  mapRight: Accessor<MapViewHandle | null>;
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
  pickAt: (side: MapSideId, point: { x: number; y: number }) => AnnotationHit | null;
  /** Also used by the edit popup's "re-capture" action. */
  captureSnapshot: () => AnnotationSnapshot;
}

export function useAnnotationCommands(
  options: UseAnnotationCommandsOptions,
): UseAnnotationCommandsResult {
  let restoreToken = 0;

  // Everything an annotation restores: filter selections, both sides'
  // (URL-addressable) layer ids + hidden ids, and the camera.
  function captureSnapshot(): AnnotationSnapshot {
    const view = options.viewState();
    return {
      areaFilterSelections: selectionsToJson(options.areaFilter.selections()),
      mapA: {
        layerIds: options.mapLeftLayers
          .layerEntries()
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...options.mapLeftLayers.hiddenIds()],
      },
      mapB: {
        layerIds: options.mapRightLayers
          .layerEntries()
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...options.mapRightLayers.hiddenIds()],
      },
      view: {
        longitude: view.longitude,
        latitude: view.latitude,
        zoom: view.zoom,
      },
    };
  }

  // The fields every new annotation shares, whatever its shape.
  function newAnnotationBase() {
    return {
      id: crypto.randomUUID(),
      title: "",
      description: "",
      color: options.identity.color,
      author: options.identity.name,
      createdAt: Date.now(),
      snapshot: captureSnapshot(),
    };
  }

  function createCircle(center: { lng: number; lat: number }, radiusM: number): string {
    const annotation: Annotation = { ...newAnnotationBase(), center, radiusM };
    options.annotations.add(annotation);
    return annotation.id;
  }

  function createPolygon(points: Array<{ lng: number; lat: number }>): string {
    const annotation: Annotation = {
      ...newAnnotationBase(),
      center: centroid(points),
      radiusM: 0,
      points,
    };
    options.annotations.add(annotation);
    return annotation.id;
  }

  function createPin(center: { lng: number; lat: number }): string {
    const annotation: Annotation = {
      ...newAnnotationBase(),
      center,
      radiusM: 0,
      pin: true,
    };
    options.annotations.add(annotation);
    return annotation.id;
  }

  function move(id: string, center: { lng: number; lat: number }) {
    options.annotations.update(id, { center });
  }

  function editPoints(
    id: string,
    points: Array<{ lng: number; lat: number }>,
    center: { lng: number; lat: number },
  ) {
    options.annotations.update(id, { points, center });
  }

  function resize(id: string, radiusM: number) {
    options.annotations.update(id, { radiusM });
  }

  // Plain click on a circle: bring the session back to the annotation's
  // snapshot. Local-only — peers' maps don't move.
  function restore(id: string) {
    const annotation = options.annotations.annotations().find((a) => a.id === id);
    if (!annotation) return;
    const token = ++restoreToken;
    void restoreSnapshot(
      annotation.snapshot,
      {
        applySelections: (next) => options.areaFilter.applySelections(next),
        sides: {
          left: { layers: options.mapLeftLayers },
          right: { layers: options.mapRightLayers },
        },
      },
      () => restoreToken !== token,
    );
  }

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
  function pickAt(side: MapSideId, point: { x: number; y: number }): AnnotationHit | null {
    const map = (side === "right" ? options.mapRight() : options.mapLeft())?.map();
    if (!map) return null;

    function query(layerIds: string[], radius: number) {
      const present = layerIds.filter((id) => map!.getLayer(id));
      if (present.length === 0) return [];
      return map!.queryRenderedFeatures(
        [
          [point.x - radius, point.y - radius],
          [point.x + radius, point.y + radius],
        ],
        { layers: present },
      );
    }
    // MapLibre carries no datum, so features reference their annotation by
    // id and it is resolved against the live list.
    function byId(id: unknown): Annotation | null {
      return options.annotations.annotations().find((a) => a.id === id) ?? null;
    }

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
  }

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
