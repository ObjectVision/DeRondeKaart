import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/** Auto-scroll when the pointer comes within this many px of a scroll edge. */
const EDGE = 28;
const EDGE_STEP = 12;

export interface RowDrag {
  /** Id of the row being dragged, or null when idle. */
  draggingId: Accessor<string | null>;
  /**
   * Display-space slot the row would drop into: 0 = above the first row, n =
   * below the last. Null when idle. Render the insertion line before the row at
   * this index.
   */
  overIndex: Accessor<number | null>;
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
 *
 * The window listeners are bound once per drag and read `ids()`, `draggingId()`
 * and `overIndex()` directly — signals are readable from anywhere, so none of
 * the three needs the shadowing ref the React version carried to avoid a stale
 * closure.
 */
export function useRowDrag(
  ids: Accessor<string[]>,
  onDrop: (id: string, toDisplayIndex: number) => void,
  /** Scroll container to auto-scroll and clamp against, if the list scrolls. */
  scrollEl?: Accessor<HTMLElement | null | undefined>,
): RowDrag {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [overIndex, setOverIndex] = createSignal<number | null>(null);

  const rows = new globalThis.Map<string, HTMLElement>();

  function rowRef(id: string) {
    return (el: HTMLElement | null) => {
      if (el) rows.set(id, el);
      else rows.delete(id);
    };
  }

  /** Which slot the pointer is currently over, in display space. */
  function slotFor(clientY: number): number {
    const order = ids();
    let slot = order.length;
    for (let i = 0; i < order.length; i++) {
      const el = rows.get(order[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // Above this row's midpoint → insert before it.
      if (clientY < r.top + r.height / 2) {
        slot = i;
        break;
      }
    }
    return slot;
  }

  function start(id: string, clientY: number) {
    setDraggingId(id);
    setOverIndex(slotFor(clientY));
  }

  createEffect(() => {
    if (!draggingId()) return;

    function move(clientY: number) {
      const s = slotFor(clientY);
      if (s !== overIndex()) setOverIndex(s);
      // Auto-scroll when dragging near an edge of the scroll container.
      const sc = scrollEl?.();
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (clientY < r.top + EDGE) sc.scrollTop -= EDGE_STEP;
        else if (clientY > r.bottom - EDGE) sc.scrollTop += EDGE_STEP;
      }
    }

    function finish() {
      const id = draggingId();
      const to = overIndex();
      setDraggingId(null);
      setOverIndex(null);
      if (id && to !== null) onDrop(id, to);
    }

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

    onCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", finish);
      window.removeEventListener("touchcancel", finish);
    });
  });

  return { draggingId, overIndex, start, rowRef };
}
