import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize } from "@/config/map-config";
import type { Annotation } from "@/types/annotation";

/** Gap between the circle's center point and the popup / viewport edges. */
const POINTER_OFFSET = 14;
const EDGE_MARGIN = 8;
/** One Y.Map write per typing pause, not per keystroke. */
const COMMIT_DEBOUNCE_MS = 300;

/**
 * Floating editor for a selected annotation, anchored just below its circle
 * center (App projects the geographic center to screen space and re-projects
 * on every view change, so the popup tracks the circle while the map moves).
 * Title/description edits are committed debounced + on blur; remote edits from
 * peers flow back in unless the local field is focused.
 */
export function AnnotationEditPopup({
  annotation,
  x,
  y,
  onChange,
  onDelete,
  onClose,
}: {
  annotation: Annotation;
  /** Projected screen position of the circle center (app-root relative). */
  x: number;
  y: number;
  onChange: (patch: Partial<Pick<Annotation, "title" | "description">>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(annotation.title);
  const [description, setDescription] = useState(annotation.description);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Pick<Annotation, "title" | "description">>>({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Selection switched to another annotation: load its text.
  useEffect(() => {
    setTitle(annotation.title);
    setDescription(annotation.description);
    pendingRef.current = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotation.id]);

  // Remote edits (a peer typing in the same annotation): adopt them unless the
  // local field is focused — the focused editor's keystrokes win locally.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(annotation.title);
  }, [annotation.title]);
  useEffect(() => {
    if (document.activeElement !== descriptionRef.current) {
      setDescription(annotation.description);
    }
  }, [annotation.description]);

  const commit = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    const pending = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(pending).length > 0) onChangeRef.current(pending);
  };

  const queue = (patch: Partial<Pick<Annotation, "title" | "description">>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commit, COMMIT_DEBOUNCE_MS);
  };

  // Flush the pending edit when the popup closes/unmounts.
  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      const pending = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(pending).length > 0) onChangeRef.current(pending);
    };
  }, []);

  // Clamp to the app root, flipping above the anchor when it doesn't fit
  // below (same placement logic as InfoPopup).
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
    return () => observer.disconnect();
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="absolute z-40 flex w-72 flex-col gap-2 rounded-lg bg-white/90 p-3 shadow-md backdrop-blur-sm"
      style={{ left: x, top: y + POINTER_OFFSET }}
    >
      <div className="flex items-center justify-between">
        <span
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: annotation.color }}
          aria-hidden
        />
        <h3 className="ml-2 flex-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Annotatie
        </h3>
        <button
          onClick={onClose}
          className="px-1 text-sm leading-none text-gray-400 transition-colors hover:text-gray-600"
          aria-label="Sluiten"
        >
          &times;
        </button>
      </div>
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
        className="rounded-lg bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-sm outline-none ring-1 ring-gray-200 placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
      />
      <textarea
        ref={descriptionRef}
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          queue({ description: e.target.value });
        }}
        onBlur={commit}
        placeholder="Beschrijving of analyse (optioneel)"
        rows={3}
        className="resize-none rounded-lg bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow-sm outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gray-400">
          {annotation.author} ·{" "}
          {new Date(annotation.createdAt).toLocaleDateString("nl-NL")}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          title="Annotatie verwijderen"
          aria-label="Annotatie verwijderen"
        >
          <Icon name="delete" size={chromeIconSize()} className="text-gray-400" />
        </Button>
      </div>
    </div>
  );
}
