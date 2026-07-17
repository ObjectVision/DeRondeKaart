import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { centroid, distanceMeters, nearestPointOnSegment } from "@/lib/geo";
import type { Annotation } from "@/types/annotation";

/** Below this screen-pixel drag distance a mouseup counts as a plain click. */
const MIN_DRAG_PX = 3;
/** Smallest committable circle radius — avoids invisible accidental circles. */
const MIN_RADIUS_M = 5;
/** Smallest committable polygon drag diagonal — avoids invisible triangles. */
const MIN_POLY_DIAG_M = 10;
/** Minimum interval between live Y.Map writes while dragging (peers see it). */
const EDIT_THROTTLE_MS = 50;

type LngLat = { lng: number; lat: number };

/** The keystroke lands in a text field (e.g. the edit popup's inputs). */
function isEditingText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable)
  );
}

/**
 * Isoceles triangle inscribed in the bbox of the two dragged corners
 * (Figma-style shape drag): apex top-center, base at the bottom.
 */
function triangleFromBbox(a: LngLat, b: LngLat): LngLat[] {
  const minLng = Math.min(a.lng, b.lng);
  const maxLng = Math.max(a.lng, b.lng);
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);
  return [
    { lng: (minLng + maxLng) / 2, lat: maxLat },
    { lng: maxLng, lat: minLat },
    { lng: minLng, lat: minLat },
  ];
}

export type AnnotationDraft =
  | { kind: "circle"; center: LngLat; radiusM: number }
  | { kind: "polygon"; points: LngLat[] };

/** Drawing tools in the annotation toolbar. */
export type AnnotationToolKind = "circle" | "polygon" | "pin";

/** What a mousedown pick hit: an annotation body, or a polygon handle. */
export type AnnotationHit =
  | { type: "circle"; annotation: Annotation }
  | { type: "polygon"; annotation: Annotation }
  | { type: "pin"; annotation: Annotation }
  /** A vertex handle of the selected polygon. */
  | { type: "vertex"; annotation: Annotation; index: number }
  /** An edge of the selected polygon; `index` is the edge's start vertex. */
  | { type: "edge"; annotation: Annotation; index: number };

type DragState =
  | {
      mode: "create";
      center: LngLat;
      startPoint: { x: number; y: number };
    }
  | {
      mode: "create-poly";
      start: LngLat;
      startPoint: { x: number; y: number };
    }
  | {
      /** Pin tool gesture — the pin is placed where the mouse is released. */
      mode: "create-pin";
      startPoint: { x: number; y: number };
    }
  | {
      /** Mousedown on empty map with no tool armed — the map pans; only used
       * to detect a plain click (deselect) on mouseup. */
      mode: "pan";
      startPoint: { x: number; y: number };
    }
  | {
      mode: "move" | "resize";
      id: string;
      /** Center/radius at drag start — restored when Escape cancels the drag. */
      startCenter: LngLat;
      startRadiusM: number;
      startLngLat: LngLat;
      startPoint: { x: number; y: number };
    }
  | {
      mode: "move-poly";
      id: string;
      /** Ring at drag start — restored when Escape cancels the drag. */
      startPoints: LngLat[];
      startLngLat: LngLat;
      startPoint: { x: number; y: number };
    }
  | {
      mode: "vertex";
      id: string;
      index: number;
      /** Ring the dragged vertex lives in (post-split for an edge split). */
      points: LngLat[];
      /** Pre-gesture ring — restored when Escape cancels (undoes a split). */
      revertPoints: LngLat[];
      startPoint: { x: number; y: number };
    };

export interface AnnotationToolOptions {
  /** Commit a completed draw; App captures the snapshot. Returns the new id. */
  onCreate(center: LngLat, radiusM: number): string;
  /** Commit a completed polygon draw. Returns the new id. */
  onCreatePolygon(points: LngLat[]): string;
  /** Commit a placed location pin. Returns the new id. */
  onCreatePin(center: LngLat): string;
  onMove(id: string, center: LngLat): void;
  onResize(id: string, radiusM: number): void;
  /** Live rewrite of a polygon's ring (move / vertex drag / edge split). */
  onEditPoints(id: string, points: LngLat[], center: LngLat): void;
  /** Plain click on an existing annotation — restore its snapshot. */
  onRestore(id: string): void;
  /** Delete/Backspace pressed while an annotation is selected. */
  onDelete(id: string): void;
  /** Synchronous deck pick against the given map side's annotation layers. */
  pickAnnotationAt(
    side: "a" | "b",
    point: { x: number; y: number },
  ): AnnotationHit | null;
}

export interface AnnotationToolState {
  /** The annotation mode is on (toolbar toggle). */
  active: boolean;
  toggle: () => void;
  /** Turn the mode on (idempotent) — used when a share link joins a collab room. */
  activate: () => void;
  /** Armed drawing tool, or null — with no tool the map navigates as usual. */
  tool: AnnotationToolKind | null;
  setTool: (tool: AnnotationToolKind | null) => void;
  /** In-progress shape while drawing a new annotation (null otherwise). */
  draft: AnnotationDraft | null;
  /** Selected annotation (edit popup target), or null. */
  selectedId: string | null;
  select: (id: string | null) => void;
  handleMouseDown: (e: MapLayerMouseEvent, side: "a" | "b") => void;
  handleMouseMove: (e: MapLayerMouseEvent) => void;
  handleMouseUp: (e: MapLayerMouseEvent) => void;
}

/**
 * State and MapLibre mouse handlers for the annotation mode, modeled on
 * use-box-select.ts. One shared instance serves both maps (annotations are
 * geographic; a drag completes on whichever map it started on).
 *
 * The mode itself doesn't claim the map: with no tool armed, dragging empty
 * map pans as usual. Only a drag that starts on an annotation, or a drag
 * while a drawing tool is armed, is intercepted:
 *
 * - circle tool + drag on empty map → draw a circle (center = mousedown,
 *   radius = drag); a successful placement disarms the tool again
 * - polygon tool + drag on empty map → drag out a bbox, committed as a
 *   triangle (Figma-style shape drag); placement disarms the tool
 * - pin tool + click → place a location pin there; placement disarms the tool
 * - drag on a circle body → move it; drag near its rim (outer 25%) → resize it
 * - drag on a pin → move it
 * - drag on a polygon body → move the whole polygon
 * - selected polygon: corner handles drag individual vertices; mousedown on an
 *   edge splits it there (Figma-style — a plain click leaves the new vertex on
 *   the edge, dragging positions it in the same gesture)
 * - plain click on an annotation → select it + restore its snapshot
 * - plain click on empty map → deselect
 * - Escape → cancel the in-progress drag (reverting a move/resize/split), else
 *   deselect, else disarm the tool; the mode itself stays on.
 * - Delete/Backspace → delete the selected annotation (unless typing in a field)
 */
export function useAnnotationTool(options: AnnotationToolOptions): AnnotationToolState {
  const [active, setActive] = useState(false);
  const [tool, setTool] = useState<AnnotationToolKind | null>(null);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastEditWriteRef = useRef(0);

  // Latest callbacks behind a stable ref, so the mouse handlers keep a stable
  // identity (they're threaded into MapView's memoized props).
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const cancelDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraft(null);
    // A cancelled move/resize/vertex drag already wrote live positions — revert.
    if (drag && drag.mode === "move") {
      optionsRef.current.onMove(drag.id, drag.startCenter);
    } else if (drag && drag.mode === "resize") {
      optionsRef.current.onResize(drag.id, drag.startRadiusM);
    } else if (drag && drag.mode === "move-poly") {
      optionsRef.current.onEditPoints(drag.id, drag.startPoints, centroid(drag.startPoints));
    } else if (drag && drag.mode === "vertex") {
      optionsRef.current.onEditPoints(drag.id, drag.revertPoints, centroid(drag.revertPoints));
    }
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const toggle = useCallback(() => {
    setActive((prev) => {
      if (prev) {
        dragRef.current = null;
        setDraft(null);
        setSelectedId(null);
      }
      return !prev;
    });
    setTool(null);
  }, []);

  const activate = useCallback(() => {
    setActive(true);
  }, []);

  const handleMouseDown = useCallback(
    (e: MapLayerMouseEvent, side: "a" | "b") => {
      if (!active) return;
      const startPoint = { x: e.point.x, y: e.point.y };
      const startLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

      const hit = optionsRef.current.pickAnnotationAt(side, startPoint);
      if (hit) {
        // Suppress MapLibre's drag-pan for this gesture only.
        e.preventDefault();
        const a = hit.annotation;
        if (hit.type === "vertex" && a.points) {
          dragRef.current = {
            mode: "vertex",
            id: a.id,
            index: hit.index,
            points: a.points,
            revertPoints: a.points,
            startPoint,
          };
        } else if (hit.type === "edge" && a.points && a.id === selectedId) {
          // Figma-style edge split: insert a vertex on the edge right away;
          // the rest of the gesture (if any) drags the new vertex.
          const insertAt = hit.index + 1;
          const onEdge = nearestPointOnSegment(
            startLngLat,
            a.points[hit.index],
            a.points[(hit.index + 1) % a.points.length],
          );
          const points = [
            ...a.points.slice(0, insertAt),
            onEdge,
            ...a.points.slice(insertAt),
          ];
          optionsRef.current.onEditPoints(a.id, points, centroid(points));
          dragRef.current = {
            mode: "vertex",
            id: a.id,
            index: insertAt,
            points,
            revertPoints: a.points,
            startPoint,
          };
        } else if ((hit.type === "polygon" || hit.type === "edge") && a.points) {
          dragRef.current = {
            mode: "move-poly",
            id: a.id,
            startPoints: a.points,
            startLngLat,
            startPoint,
          };
        } else if (hit.type === "pin") {
          // Pins have no rim to resize — any drag moves them.
          dragRef.current = {
            mode: "move",
            id: a.id,
            startCenter: a.center,
            startRadiusM: 0,
            startLngLat,
            startPoint,
          };
        } else {
          // Inner 75% of the radius drags the circle; the rim band resizes it.
          const mode =
            distanceMeters(startLngLat, a.center) / a.radiusM > 0.75
              ? "resize"
              : "move";
          dragRef.current = {
            mode,
            id: a.id,
            startCenter: a.center,
            startRadiusM: a.radiusM,
            startLngLat,
            startPoint,
          };
        }
      } else if (tool === "circle") {
        e.preventDefault();
        dragRef.current = { mode: "create", center: startLngLat, startPoint };
      } else if (tool === "polygon") {
        e.preventDefault();
        dragRef.current = { mode: "create-poly", start: startLngLat, startPoint };
      } else if (tool === "pin") {
        e.preventDefault();
        dragRef.current = { mode: "create-pin", startPoint };
      } else {
        // No tool armed: let the map pan; remember the start point only to
        // recognize a plain click (deselect) on mouseup.
        dragRef.current = { mode: "pan", startPoint };
      }
    },
    [active, tool, selectedId],
  );

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") return; // the map handles the drag itself
    if (drag.mode === "create-pin") return; // placed on mouseup, no preview

    if (drag.mode === "create") {
      setDraft({
        kind: "circle",
        center: drag.center,
        radiusM: distanceMeters(drag.center, e.lngLat),
      });
      return;
    }
    if (drag.mode === "create-poly") {
      setDraft({ kind: "polygon", points: triangleFromBbox(drag.start, e.lngLat) });
      return;
    }

    // Live-write moves/resizes (throttled) so collaborators see the drag.
    const now = performance.now();
    if (now - lastEditWriteRef.current < EDIT_THROTTLE_MS) return;
    lastEditWriteRef.current = now;
    if (drag.mode === "move") {
      optionsRef.current.onMove(drag.id, {
        lng: drag.startCenter.lng + (e.lngLat.lng - drag.startLngLat.lng),
        lat: drag.startCenter.lat + (e.lngLat.lat - drag.startLngLat.lat),
      });
    } else if (drag.mode === "resize") {
      optionsRef.current.onResize(
        drag.id,
        Math.max(MIN_RADIUS_M, distanceMeters(drag.startCenter, e.lngLat)),
      );
    } else if (drag.mode === "move-poly") {
      const dLng = e.lngLat.lng - drag.startLngLat.lng;
      const dLat = e.lngLat.lat - drag.startLngLat.lat;
      const points = drag.startPoints.map((p) => ({
        lng: p.lng + dLng,
        lat: p.lat + dLat,
      }));
      optionsRef.current.onEditPoints(drag.id, points, centroid(points));
    } else {
      const points = drag.points.map((p, i) =>
        i === drag.index ? { lng: e.lngLat.lng, lat: e.lngLat.lat } : p,
      );
      optionsRef.current.onEditPoints(drag.id, points, centroid(points));
    }
  }, []);

  const handleMouseUp = useCallback(
    (e: MapLayerMouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setDraft(null);

      const dx = e.point.x - drag.startPoint.x;
      const dy = e.point.y - drag.startPoint.y;
      const isClick = Math.hypot(dx, dy) < MIN_DRAG_PX;

      if (drag.mode === "pan") {
        // Plain click on empty map: just deselect. A real drag panned the map.
        if (isClick) setSelectedId(null);
        return;
      }

      if (drag.mode === "create") {
        if (isClick) {
          // Plain click while a draw tool is armed: deselect, keep the tool
          // armed so the next drag still places the shape.
          setSelectedId(null);
          return;
        }
        const radiusM = distanceMeters(drag.center, e.lngLat);
        if (radiusM < MIN_RADIUS_M) return;
        const id = optionsRef.current.onCreate(drag.center, radiusM);
        setSelectedId(id);
        // One shape per arming — placing it returns to map navigation.
        setTool(null);
        return;
      }

      if (drag.mode === "create-poly") {
        if (isClick) {
          setSelectedId(null);
          return;
        }
        if (distanceMeters(drag.start, e.lngLat) < MIN_POLY_DIAG_M) return;
        const id = optionsRef.current.onCreatePolygon(
          triangleFromBbox(drag.start, e.lngLat),
        );
        setSelectedId(id);
        setTool(null);
        return;
      }

      if (drag.mode === "create-pin") {
        // Click or drag alike: the pin lands where the mouse was released.
        const id = optionsRef.current.onCreatePin({
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
        });
        setSelectedId(id);
        setTool(null);
        return;
      }

      if (isClick) {
        // A vertex/edge gesture that ends as a click: the edge split (applied
        // on mousedown) stands; a plain vertex click changes nothing.
        if (drag.mode === "vertex") return;
        // Plain click on an annotation: select + restore its snapshot.
        setSelectedId(drag.id);
        optionsRef.current.onRestore(drag.id);
        return;
      }

      // Final commit of the drag's end position (the throttle may have
      // swallowed the last few mousemoves).
      if (drag.mode === "move") {
        optionsRef.current.onMove(drag.id, {
          lng: drag.startCenter.lng + (e.lngLat.lng - drag.startLngLat.lng),
          lat: drag.startCenter.lat + (e.lngLat.lat - drag.startLngLat.lat),
        });
      } else if (drag.mode === "resize") {
        optionsRef.current.onResize(
          drag.id,
          Math.max(MIN_RADIUS_M, distanceMeters(drag.startCenter, e.lngLat)),
        );
      } else if (drag.mode === "move-poly") {
        const dLng = e.lngLat.lng - drag.startLngLat.lng;
        const dLat = e.lngLat.lat - drag.startLngLat.lat;
        const points = drag.startPoints.map((p) => ({
          lng: p.lng + dLng,
          lat: p.lat + dLat,
        }));
        optionsRef.current.onEditPoints(drag.id, points, centroid(points));
      } else {
        const points = drag.points.map((p, i) =>
          i === drag.index ? { lng: e.lngLat.lng, lat: e.lngLat.lat } : p,
        );
        optionsRef.current.onEditPoints(drag.id, points, centroid(points));
      }
    },
    [],
  );

  // MapLibre won't fire its mouseup when the button is released outside the
  // canvas — cancel any leftover drag from the window as a fallback.
  useEffect(() => {
    if (!active) return;
    function onWindowMouseUp() {
      if (dragRef.current) cancelDrag();
    }
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [active, cancelDrag]);

  // Escape: cancel an in-progress drag, otherwise deselect (close the popup),
  // otherwise disarm the drawing tool. Deliberately does NOT exit the mode —
  // that's the toolbar button's job.
  // Delete/Backspace: delete the selected annotation — unless the keystroke is
  // editing text (the popup's title/description fields).
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (dragRef.current) {
          cancelDrag();
        } else if (selectedId) {
          setSelectedId(null);
        } else {
          setTool(null);
        }
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedId &&
        !dragRef.current &&
        !isEditingText(e.target)
      ) {
        e.preventDefault();
        setSelectedId(null);
        optionsRef.current.onDelete(selectedId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, cancelDrag, selectedId]);

  return useMemo(
    () => ({
      active,
      toggle,
      activate,
      tool,
      setTool,
      draft,
      selectedId,
      select,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
    }),
    [active, toggle, activate, tool, draft, selectedId, select, handleMouseDown, handleMouseMove, handleMouseUp],
  );
}
