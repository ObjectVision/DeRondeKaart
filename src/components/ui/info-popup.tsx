import { createEffect, onCleanup, type JSX } from "solid-js";
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

/**
 * Combined Details/Street View window, popping up just below the mouse
 * pointer with a single close button top right. Styled like the legend card.
 * Position is clamped to the app root; when it doesn't fit below the pointer
 * it flips above. Re-clamps when async content (templates, panorama) resizes.
 */
export function InfoPopup(props: InfoPopupProps): JSX.Element {
  let el!: HTMLDivElement;

  createEffect(() => {
    // Tracked so a new click position re-places the window.
    const x = props.x;
    const y = props.y;
    const parent = el.parentElement;
    if (!parent) return;

    function place() {
      if (!parent) return;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const maxLeft = parent.clientWidth - width - EDGE_MARGIN;
      const left = Math.max(EDGE_MARGIN, Math.min(x, maxLeft));
      let top = y + POINTER_OFFSET;
      if (top + height + EDGE_MARGIN > parent.clientHeight) {
        const above = y - POINTER_OFFSET - height;
        top =
          above >= EDGE_MARGIN
            ? above
            : Math.max(EDGE_MARGIN, parent.clientHeight - height - EDGE_MARGIN);
      }
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={el}
      class={
        "absolute z-40 flex flex-col rounded-2xl bg-white/95 shadow-md backdrop-blur-sm " +
        (props.wide ? "w-[min(750px,calc(100vw-2rem))] max-h-[90vh]" : "w-150 max-h-[35vh]")
      }
      style={{ left: `${props.x}px`, top: `${props.y + POINTER_OFFSET}px` }}
    >
      {/* Header — the popup's single close button. Same heading treatment and
          close control as the "Referentielagen" and metainfo dialogs, so the
          app's windows read as one family. */}
      <div class="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
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
