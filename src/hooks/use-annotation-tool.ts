import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { distanceMeters } from "@/lib/geo";
import type { Annotation } from "@/types/annotation";

/** Below this screen-pixel drag distance a mouseup counts as a plain click. */
const MIN_DRAG_PX = 3;
/** Smallest committable circle radius — avoids invisible accidental circles. */
const MIN_RADIUS_M = 5;
/** Minimum interval between live Y.Map writes while dragging (peers see it). */
const EDIT_THROTTLE_MS = 50;

/** The keystroke lands in a text field (e.g. the edit popup's inputs). */
function isEditingText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable)
  );
}

export interface AnnotationDraft {
  center: { lng: number; lat: number };
  radiusM: number;
}

type DragState =
  | {
      mode: "create";
      center: { lng: number; lat: number };
      startPoint: { x: number; y: number };
    }
  | {
      mode: "move" | "resize";
      id: string;
      /** Center/radius at drag start — restored when Escape cancels the drag. */
      startCenter: { lng: number; lat: number };
      startRadiusM: number;
      startLngLat: { lng: number; lat: number };
      startPoint: { x: number; y: number };
    };

export interface AnnotationToolOptions {
  /** Commit a completed draw; App captures the snapshot. Returns the new id. */
  onCreate(center: { lng: number; lat: number }, radiusM: number): string;
  onMove(id: string, center: { lng: number; lat: number }): void;
  onResize(id: string, radiusM: number): void;
  /** Plain click on an existing circle — restore its snapshot. */
  onRestore(id: string): void;
  /** Delete/Backspace pressed while a circle is selected. */
  onDelete(id: string): void;
  /** Synchronous deck pick against the given map side's annotation circles. */
  pickAnnotationAt(
    side: "a" | "b",
    point: { x: number; y: number },
  ): Annotation | null;
}

export interface AnnotationToolState {
  /** The annotation tool is armed (toolbar toggle on). */
  active: boolean;
  toggle: () => void;
  /** Arm the tool (idempotent) — used when a share link joins a collab room. */
  activate: () => void;
  /** In-progress circle while drawing a new annotation (null otherwise). */
  draft: AnnotationDraft | null;
  /** Selected annotation (edit popup target), or null. */
  selectedId: string | null;
  select: (id: string | null) => void;
  handleMouseDown: (e: MapLayerMouseEvent, side: "a" | "b") => void;
  handleMouseMove: (e: MapLayerMouseEvent) => void;
  handleMouseUp: (e: MapLayerMouseEvent) => void;
}

/**
 * State and MapLibre mouse handlers for the annotation tool, modeled on
 * use-box-select.ts. One shared instance serves both maps (annotations are
 * geographic; a drag completes on whichever map it started on):
 *
 * - drag on empty map     → draw a new circle (center = mousedown, radius = drag)
 * - drag on a circle body → move it; drag near its rim (outer 25%) → resize it
 * - plain click on a circle → select it + restore its snapshot
 * - plain click on empty map → deselect
 * - Escape → cancel the in-progress drag (reverting a move/resize), else
 *   deselect; the tool itself stays armed.
 * - Delete/Backspace → delete the selected circle (unless typing in a field)
 */
export function useAnnotationTool(options: AnnotationToolOptions): AnnotationToolState {
  const [active, setActive] = useState(false);
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
    // A cancelled move/resize already wrote live positions — revert them.
    if (drag && drag.mode === "move") {
      optionsRef.current.onMove(drag.id, drag.startCenter);
    } else if (drag && drag.mode === "resize") {
      optionsRef.current.onResize(drag.id, drag.startRadiusM);
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
  }, []);

  const activate = useCallback(() => {
    setActive(true);
  }, []);

  const handleMouseDown = useCallback(
    (e: MapLayerMouseEvent, side: "a" | "b") => {
      if (!active) return;
      // Suppress MapLibre's drag-pan for this gesture only.
      e.preventDefault();
      const startPoint = { x: e.point.x, y: e.point.y };
      const startLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };

      const hit = optionsRef.current.pickAnnotationAt(side, startPoint);
      if (hit) {
        // Inner 75% of the radius drags the circle; the rim band resizes it.
        const mode =
          distanceMeters(startLngLat, hit.center) / hit.radiusM > 0.75
            ? "resize"
            : "move";
        dragRef.current = {
          mode,
          id: hit.id,
          startCenter: hit.center,
          startRadiusM: hit.radiusM,
          startLngLat,
          startPoint,
        };
      } else {
        dragRef.current = { mode: "create", center: startLngLat, startPoint };
      }
    },
    [active],
  );

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.mode === "create") {
      setDraft({
        center: drag.center,
        radiusM: distanceMeters(drag.center, e.lngLat),
      });
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
    } else {
      optionsRef.current.onResize(
        drag.id,
        Math.max(MIN_RADIUS_M, distanceMeters(drag.startCenter, e.lngLat)),
      );
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

      if (drag.mode === "create") {
        if (isClick) {
          // Plain click on empty map: just deselect.
          setSelectedId(null);
          return;
        }
        const radiusM = distanceMeters(drag.center, e.lngLat);
        if (radiusM < MIN_RADIUS_M) return;
        const id = optionsRef.current.onCreate(drag.center, radiusM);
        setSelectedId(id);
        return;
      }

      if (isClick) {
        // Plain click on a circle: select + restore its snapshot.
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
      } else {
        optionsRef.current.onResize(
          drag.id,
          Math.max(MIN_RADIUS_M, distanceMeters(drag.startCenter, e.lngLat)),
        );
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

  // Escape: cancel an in-progress drag, otherwise deselect (close the popup).
  // Deliberately does NOT exit the mode — that's the toolbar button's job.
  // Delete/Backspace: delete the selected circle — unless the keystroke is
  // editing text (the popup's title/description fields).
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (dragRef.current) {
          cancelDrag();
        } else {
          setSelectedId(null);
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
      draft,
      selectedId,
      select,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
    }),
    [active, toggle, activate, draft, selectedId, select, handleMouseDown, handleMouseMove, handleMouseUp],
  );
}
