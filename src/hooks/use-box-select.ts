import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { MapLayerMouseEvent } from "@/components/map/map-view-config";
import { boxFilter, setBoxFilter, type BBox } from "@/layers/box-filter";

/** Below this screen-pixel drag distance a mouseup counts as a plain click. */
const MIN_DRAG_PX = 3;

export interface BoxSelectState {
  /** The area-select tool is armed (toolbar toggle on). */
  active: Accessor<boolean>;
  /** Toolbar handler; toggling OFF clears the box and restores full stats. */
  toggle: () => void;
  /**
   * The committed selection box. This is the module store's own signal, not a
   * copy — the React version mirrored it into local state (plus a version
   * counter) because the store was not observable.
   */
  box: Accessor<BBox | null>;
  /** In-progress box while dragging (null otherwise). */
  draft: Accessor<BBox | null>;
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
  const [active, setActive] = createSignal(false);
  const [draft, setDraft] = createSignal<BBox | null>(null);
  // Plain variable: the gesture's anchor is never rendered.
  let dragStart: {
    lngLat: { lng: number; lat: number };
    point: { x: number; y: number };
  } | null = null;

  function cancelDrag() {
    dragStart = null;
    setDraft(null);
  }

  function toggle() {
    const wasActive = active();
    if (wasActive) {
      cancelDrag();
      setBoxFilter(null);
    }
    setActive(!wasActive);
  }

  function handleMouseDown(e: MapLayerMouseEvent) {
    if (!active()) return;
    // Suppress MapLibre's drag-pan for this gesture only.
    e.preventDefault();
    dragStart = {
      lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
      point: { x: e.point.x, y: e.point.y },
    };
  }

  function handleMouseMove(e: MapLayerMouseEvent) {
    if (!dragStart) return;
    setDraft(normalizedBBox(dragStart.lngLat, e.lngLat));
  }

  function handleMouseUp(e: MapLayerMouseEvent) {
    if (!dragStart) return;
    const dx = e.point.x - dragStart.point.x;
    const dy = e.point.y - dragStart.point.y;
    // A near-zero drag is a plain click: keep the previous box.
    if (Math.hypot(dx, dy) >= MIN_DRAG_PX) {
      setBoxFilter(normalizedBBox(dragStart.lngLat, e.lngLat));
    }
    cancelDrag();
  }

  // MapLibre won't fire its mouseup when the button is released outside the
  // canvas — cancel any leftover drag from the window as a fallback. This
  // bubbles after the map's own mouseup, so a completed drag is unaffected.
  createEffect(() => {
    if (!active()) return;
    function onWindowMouseUp() {
      if (dragStart) cancelDrag();
    }
    window.addEventListener("mouseup", onWindowMouseUp);
    onCleanup(() => window.removeEventListener("mouseup", onWindowMouseUp));
  });

  // Escape: cancel an in-progress drag, otherwise clear the committed box.
  createEffect(() => {
    if (!active()) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (dragStart) cancelDrag();
      else setBoxFilter(null);
    }
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return {
    active,
    toggle,
    box: boxFilter,
    draft,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  };
}
