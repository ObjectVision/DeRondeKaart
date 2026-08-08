import { useCallback, useEffect, useRef, useState } from "react";

/** Auto-scroll when the pointer comes within this many px of a scroll edge. */
const EDGE = 28;
const EDGE_STEP = 12;

export interface RowDrag {
  /** Id of the row being dragged, or null when idle. */
  draggingId: string | null;
  /**
   * Display-space slot the row would drop into: 0 = above the first row, n =
   * below the last. Null when idle. Render the insertion line before the row at
   * this index.
   */
  overIndex: number | null;
  /** Start a drag from a handle's onMouseDown/onTouchStart. */
  start: (id: string, clientY: number) => void;
  /** Register each row's element so hit-testing can measure it. */
  rowRef: (id: string) => (el: HTMLElement | null) => void;
}

/**
 * Pointer-driven vertical row reordering for a scrollable list.
 *
 * Mouse + touch via window listeners (the same idiom as comparison-slider.tsx)
 * rather than HTML5 drag-and-drop, which does not fire on touch and cannot be
 * styled. Hit-testing uses getBoundingClientRect so it stays correct while the
 * container is scrolled — and mid-drag, since the container auto-scrolls near
 * its edges.
 *
 * `ids` must be in the same order the rows are rendered. `onDrop` receives the
 * dragged id and the display-space index it was released at; the caller converts
 * to whatever order its state uses.
 */
export function useRowDrag(
  ids: string[],
  onDrop: (id: string, toDisplayIndex: number) => void,
  /** Scroll container to auto-scroll and clamp against, if the list scrolls. */
  scrollRef?: React.RefObject<HTMLElement | null>,
): RowDrag {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const rows = useRef(new globalThis.Map<string, HTMLElement>());
  // Read by the window listeners, which are bound once per drag and so must not
  // close over a stale `ids`.
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);
  const overRef = useRef<number | null>(null);
  const dragRef = useRef<string | null>(null);

  const rowRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
    },
    [],
  );

  /** Which slot the pointer is currently over, in display space. */
  const slotFor = useCallback((clientY: number): number => {
    const order = idsRef.current;
    let slot = order.length;
    for (let i = 0; i < order.length; i++) {
      const el = rows.current.get(order[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // Above this row's midpoint → insert before it.
      if (clientY < r.top + r.height / 2) {
        slot = i;
        break;
      }
    }
    return slot;
  }, []);

  const start = useCallback((id: string, clientY: number) => {
    dragRef.current = id;
    setDraggingId(id);
    const s = slotFor(clientY);
    overRef.current = s;
    setOverIndex(s);
  }, [slotFor]);

  useEffect(() => {
    if (!draggingId) return;

    const move = (clientY: number) => {
      const s = slotFor(clientY);
      if (s !== overRef.current) {
        overRef.current = s;
        setOverIndex(s);
      }
      // Auto-scroll when dragging near an edge of the scroll container.
      const sc = scrollRef?.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (clientY < r.top + EDGE) sc.scrollTop -= EDGE_STEP;
        else if (clientY > r.bottom - EDGE) sc.scrollTop += EDGE_STEP;
      }
    };

    const finish = () => {
      const id = dragRef.current;
      const to = overRef.current;
      dragRef.current = null;
      overRef.current = null;
      setDraggingId(null);
      setOverIndex(null);
      if (id && to !== null) onDrop(id, to);
    };

    function onMouseMove(e: MouseEvent) {
      e.preventDefault();
      move(e.clientY);
    }
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      move(e.touches[0].clientY);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finish);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", finish);
    window.addEventListener("touchcancel", finish);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("touchcancel", finish);
    };
  }, [draggingId, slotFor, onDrop, scrollRef]);

  return { draggingId, overIndex, start, rowRef };
}
