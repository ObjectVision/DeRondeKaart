import { useCallback, useEffect, useRef, useState } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { setBoxFilter, type BBox } from "@/layers/box-filter";

/** Below this screen-pixel drag distance a mouseup counts as a plain click. */
const MIN_DRAG_PX = 3;

export interface BoxSelectState {
  /** The area-select tool is armed (toolbar toggle on). */
  active: boolean;
  /** Toolbar handler; toggling OFF clears the box and restores full stats. */
  toggle: () => void;
  /** Committed selection box, mirrored from the module store. */
  box: BBox | null;
  /** In-progress box while dragging (null otherwise). */
  draft: BBox | null;
  /** Mirrors the box-filter store version (chart-data cache key component). */
  version: number;
  handleMouseDown: (e: MapLayerMouseEvent) => void;
  handleMouseMove: (e: MapLayerMouseEvent) => void;
  handleMouseUp: (e: MapLayerMouseEvent) => void;
}

function normalizedBBox(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): BBox {
  return [
    Math.min(a.lng, b.lng),
    Math.min(a.lat, b.lat),
    Math.max(a.lng, b.lng),
    Math.max(a.lat, b.lat),
  ];
}

/**
 * State and MapLibre mouse handlers for the area-select tool. One shared
 * instance serves both maps: the box is a single shared filter, and a drag
 * completes on whichever map it started on. Drawing a new box replaces the
 * previous one; Escape cancels the draft or clears the committed box.
 */
export function useBoxSelect(): BoxSelectState {
  const [active, setActive] = useState(false);
  const [box, setBox] = useState<BBox | null>(null);
  const [draft, setDraft] = useState<BBox | null>(null);
  const [version, setVersion] = useState(0);
  const dragStartRef = useRef<{
    lngLat: { lng: number; lat: number };
    point: { x: number; y: number };
  } | null>(null);

  /** Push the new box into the module store and mirror its version. */
  const commit = useCallback((next: BBox | null) => {
    setBox(next);
    setVersion(setBoxFilter(next));
  }, []);

  const cancelDrag = useCallback(() => {
    dragStartRef.current = null;
    setDraft(null);
  }, []);

  const toggle = useCallback(() => {
    setActive((prev) => {
      if (prev) {
        cancelDrag();
        commit(null);
      }
      return !prev;
    });
  }, [cancelDrag, commit]);

  const handleMouseDown = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!active) return;
      // Suppress MapLibre's drag-pan for this gesture only.
      e.preventDefault();
      dragStartRef.current = {
        lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        point: { x: e.point.x, y: e.point.y },
      };
    },
    [active],
  );

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    setDraft(normalizedBBox(start.lngLat, e.lngLat));
  }, []);

  const handleMouseUp = useCallback(
    (e: MapLayerMouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.point.x - start.point.x;
      const dy = e.point.y - start.point.y;
      // A near-zero drag is a plain click: keep the previous box.
      if (Math.hypot(dx, dy) >= MIN_DRAG_PX) {
        commit(normalizedBBox(start.lngLat, e.lngLat));
      }
      cancelDrag();
    },
    [cancelDrag, commit],
  );

  // MapLibre won't fire its mouseup when the button is released outside the
  // canvas — cancel any leftover drag from the window as a fallback. This
  // bubbles after the map's own mouseup, so a completed drag is unaffected.
  useEffect(() => {
    if (!active) return;
    function onWindowMouseUp() {
      if (dragStartRef.current) cancelDrag();
    }
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [active, cancelDrag]);

  // Escape: cancel an in-progress drag, otherwise clear the committed box.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (dragStartRef.current) {
        cancelDrag();
      } else {
        commit(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, cancelDrag, commit]);

  return { active, toggle, box, draft, version, handleMouseDown, handleMouseMove, handleMouseUp };
}
