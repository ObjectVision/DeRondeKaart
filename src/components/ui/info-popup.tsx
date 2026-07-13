import { useLayoutEffect, useRef } from "react";

interface InfoPopupProps {
  /** Click position in pixels, relative to the app root (= map container). */
  x: number;
  y: number;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
export function InfoPopup({ x, y, title, onClose, children }: InfoPopupProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    function place() {
      if (!el || !parent) return;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const maxLeft = parent.clientWidth - width - EDGE_MARGIN;
      const left = Math.max(EDGE_MARGIN, Math.min(x, maxLeft));
      let top = y + POINTER_OFFSET;
      if (top + height + EDGE_MARGIN > parent.clientHeight) {
        const above = y - POINTER_OFFSET - height;
        top = above >= EDGE_MARGIN
          ? above
          : Math.max(EDGE_MARGIN, parent.clientHeight - height - EDGE_MARGIN);
      }
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="absolute z-40 w-80 max-h-[60vh] flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm"
      style={{ left: x, top: y + POINTER_OFFSET }}
    >
      {/* Header — the popup's single close button */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>
      <div className="flex min-h-0 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}
