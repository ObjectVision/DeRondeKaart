import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

interface InfoPopupProps {
  /** Click position in pixels, relative to the app root (= map container). */
  x: number;
  y: number;
  title: string;
  onClose: () => void;
  children: JSX.Element;
  /**
   * Size the window around an embedded viewer rather than an attribute table.
   * PBL's summary lays out at a fixed 750px wide whatever room it is given, so
   * this fits that exactly instead of framing it in empty space.
   */
  wide?: boolean;
}

/** Gap between the pointer and the popup, and between popup and viewport edge. */
const POINTER_OFFSET = 12;
const EDGE_MARGIN = 8;

export interface Placement {
  left: number;
  top: number;
}

/**
 * Hold a box inside its parent, `EDGE_MARGIN` from every edge.
 *
 * A box wider or taller than the parent pins to the top-left margin rather than
 * centring on the overflow: the header — the close button, and now the drag
 * handle — lives at the top, so that is the end that has to stay reachable.
 */
export function clampToParent(
  left: number,
  top: number,
  width: number,
  height: number,
  parentWidth: number,
  parentHeight: number,
): Placement {
  const maxLeft = parentWidth - width - EDGE_MARGIN;
  const maxTop = parentHeight - height - EDGE_MARGIN;
  return {
    left: Math.max(EDGE_MARGIN, Math.min(left, maxLeft)),
    top: Math.max(EDGE_MARGIN, Math.min(top, maxTop)),
  };
}

/**
 * Where the window opens: `POINTER_OFFSET` below the click, flipped above when
 * it would not fit below, and clamped to the parent either way.
 *
 * The flip is tried before the clamp so a window that does fit above lands
 * there whole, rather than being squashed against the bottom margin.
 */
export function placeBelowPointer(
  x: number,
  y: number,
  width: number,
  height: number,
  parentWidth: number,
  parentHeight: number,
): Placement {
  let top = y + POINTER_OFFSET;
  if (top + height + EDGE_MARGIN > parentHeight) {
    const above = y - POINTER_OFFSET - height;
    if (above >= EDGE_MARGIN) top = above;
  }
  return clampToParent(x, top, width, height, parentWidth, parentHeight);
}

/**
 * Combined Details/Street View window, popping up just below the mouse
 * pointer with a single close button top right. Styled like the legend card.
 *
 * It opens anchored to the click — clamped to the app root, flipping above the
 * pointer when it does not fit below — and stays anchored while its content
 * settles, since templates and the Street View panorama load async and resize
 * it after it is already on screen.
 *
 * Dragging the header takes that over: from then on the window stays where the
 * user put it, and a later resize only re-clamps it so growing content cannot
 * push it off-screen. The next click re-anchors, because the window belongs to
 * the click that opened it.
 */
export function InfoPopup(props: InfoPopupProps): JSX.Element {
  let el!: HTMLDivElement;

  const [dragging, setDragging] = createSignal(false);
  /**
   * Whether the user has taken the position over. Plain values, not signals:
   * nothing renders from them, and the drag writes `style.left/top` directly
   * the way the placement effect always has.
   */
  let dragged = false;
  /** Pointer offset inside the window at grab time, so it does not jump. */
  let grabDX = 0;
  let grabDY = 0;

  createEffect(() => {
    // Tracked so a new click position re-places the window.
    const x = props.x;
    const y = props.y;
    const parent = el.parentElement;
    if (!parent) return;

    // A new click re-anchors, whatever the user did with the previous one.
    dragged = false;

    function apply({ left, top }: Placement) {
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    function place() {
      if (!parent) return;
      apply(
        placeBelowPointer(
          x,
          y,
          el.offsetWidth,
          el.offsetHeight,
          parent.clientWidth,
          parent.clientHeight,
        ),
      );
    }

    /** Keep a dragged window where it is, but inside the parent. */
    function reclamp() {
      if (!parent) return;
      apply(
        clampToParent(
          el.offsetLeft,
          el.offsetTop,
          el.offsetWidth,
          el.offsetHeight,
          parent.clientWidth,
          parent.clientHeight,
        ),
      );
    }

    place();
    const observer = new ResizeObserver(() => (dragged ? reclamp() : place()));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  function startDrag(clientX: number, clientY: number) {
    const rect = el.getBoundingClientRect();
    grabDX = clientX - rect.left;
    grabDY = clientY - rect.top;
    dragged = true;
    setDragging(true);
  }

  function moveTo(clientX: number, clientY: number) {
    const parent = el.parentElement;
    if (!parent) return;
    // `left`/`top` are relative to the app root, so the pointer's client
    // coordinates have to come back into the parent's frame first.
    const rect = parent.getBoundingClientRect();
    const { left, top } = clampToParent(
      clientX - rect.left - grabDX,
      clientY - rect.top - grabDY,
      el.offsetWidth,
      el.offsetHeight,
      parent.clientWidth,
      parent.clientHeight,
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // Window listeners for the duration of the drag, the same idiom as
  // comparison-slider.tsx and use-row-drag.ts: the pointer regularly leaves the
  // small header while dragging, and it may be released anywhere.
  createEffect(() => {
    if (!dragging()) return;

    function onMouseMove(e: MouseEvent) {
      e.preventDefault();
      moveTo(e.clientX, e.clientY);
    }
    function onMouseUp() {
      setDragging(false);
    }
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      moveTo(e.touches[0].clientX, e.touches[0].clientY);
    }
    function onTouchEnd() {
      setDragging(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);

    onCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    });
  });

  /** The close button sits in the header; pressing it must not start a drag. */
  const fromButton = (e: Event) =>
    Boolean((e.target as HTMLElement | null)?.closest("button"));

  return (
    <div
      ref={el}
      class={
        "absolute z-40 flex flex-col rounded-2xl bg-white/95 shadow-md backdrop-blur-sm " +
        (props.wide ? "w-[min(750px,calc(100vw-2rem))] max-h-[90vh]" : "w-150 max-h-[35vh]")
      }
      style={{ left: `${props.x}px`, top: `${props.y + POINTER_OFFSET}px` }}
    >
      {/* Header — the popup's drag handle and its single close button. Same
          heading treatment and close control as the "Referentielagen" and
          metainfo dialogs, so the app's windows read as one family. */}
      <div
        class={
          "flex select-none items-center justify-between gap-2 px-3 pt-2 pb-1 " +
          (dragging() ? "cursor-grabbing" : "cursor-grab")
        }
        onMouseDown={(e) => {
          if (fromButton(e)) return;
          // Suppresses the text selection a drag across the title would make.
          e.preventDefault();
          startDrag(e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          // Deliberately no preventDefault: it would swallow the close tap.
          if (fromButton(e)) return;
          startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }}
      >
        <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {props.title}
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={props.onClose}
          title="Sluiten"
          aria-label="Sluiten"
        >
          <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
        </Button>
      </div>
      {/* This element owns the scrolling, so `app-scrollbar` lands here — it
          matches the navigation and legend cards' scrollbar. */}
      <div class="app-scrollbar flex min-h-0 flex-col overflow-y-auto">{props.children}</div>
    </div>
  );
}
