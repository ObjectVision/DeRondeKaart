import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Annotation } from "@/types/annotation";

/** Gap between the shape's top point and the box / viewport edges. */
const POINTER_OFFSET = 14;
const EDGE_MARGIN = 8;
/** One Y.Map write per typing pause, not per keystroke. */
const COMMIT_DEBOUNCE_MS = 300;

/**
 * Floating title box for a selected annotation, anchored just above the top
 * of its shape (App projects the shape's top point to screen space and
 * re-projects on every view change, so the box tracks the shape while the map
 * moves). Title edits are committed debounced + on blur; remote edits from
 * peers flow back in unless the field is focused. Reduced to the title only
 * for now — description editing was removed.
 */
export function AnnotationEditPopup({
  annotation,
  x,
  y,
  onChange,
}: {
  annotation: Annotation;
  /** Projected screen position of the shape's top point (app-root relative). */
  x: number;
  y: number;
  onChange: (patch: Partial<Pick<Annotation, "title">>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(annotation.title);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Pick<Annotation, "title">>>({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Selection switched to another annotation: load its text.
  useEffect(() => {
    setTitle(annotation.title);
    pendingRef.current = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotation.id]);

  // Remote edits (a peer typing in the same annotation): adopt them unless the
  // local field is focused — the focused editor's keystrokes win locally.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(annotation.title);
  }, [annotation.title]);

  const commit = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    const pending = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(pending).length > 0) onChangeRef.current(pending);
  };

  const queue = (patch: Partial<Pick<Annotation, "title">>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commit, COMMIT_DEBOUNCE_MS);
  };

  // Flush the pending edit when the box closes/unmounts.
  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      const pending = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(pending).length > 0) onChangeRef.current(pending);
    };
  }, []);

  // Clamp to the app root; sits above the shape's top point, flipping below
  // it when there is no room above.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    function place() {
      if (!el || !parent) return;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const maxLeft = parent.clientWidth - width - EDGE_MARGIN;
      const left = Math.max(EDGE_MARGIN, Math.min(x - width / 2, maxLeft));
      let top = y - POINTER_OFFSET - height;
      if (top < EDGE_MARGIN) {
        const below = y + POINTER_OFFSET;
        top =
          below + height + EDGE_MARGIN <= parent.clientHeight
            ? below
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
      className="absolute z-40 w-56 rounded-lg bg-white/90 p-1.5 shadow-md backdrop-blur-sm"
      style={{ left: x, top: y - POINTER_OFFSET }}
    >
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          queue({ title: e.target.value });
        }}
        onBlur={commit}
        placeholder="Titel"
        className="w-full rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-sm outline-none ring-1 ring-gray-200 placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
      />
    </div>
  );
}
