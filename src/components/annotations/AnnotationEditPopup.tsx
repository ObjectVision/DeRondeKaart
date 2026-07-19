import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconSize, chromeIconColor } from "@/config/map-config";
import type { Annotation } from "@/types/annotation";

/** Gap between the shape's top point and the chrome / viewport edges. */
const POINTER_OFFSET = 14;
const EDGE_MARGIN = 8;
/** One Y.Map write per typing pause, not per keystroke. */
const COMMIT_DEBOUNCE_MS = 300;

/**
 * Floating chrome for the selected annotation, anchored just above the top of
 * its shape (App projects the shape's top point to screen space and
 * re-projects on every view change, so it tracks the shape while the map
 * moves). The titlebox itself is an inline editor (type to rename; committed
 * debounced + on blur; remote edits from peers flow back in unless the field
 * is focused), with two toolbuttons beside it:
 *
 * - screenshot_frame_2 re-captures the annotation's full session snapshot
 *   (both maps' layers, gebiedsfilters, camera) — a later restore returns to
 *   the state as it is now
 * - info shows who created the annotation and when, plus the description —
 *   readable in place and editable via the edit/edit_off toggle
 *
 * The info panel stacks above the titlebox row, growing away from the shape.
 */
export function AnnotationEditPopup({
  annotation,
  x,
  y,
  onChange,
  onRecapture,
}: {
  annotation: Annotation;
  /** Projected screen position of the shape's top point (app-root relative). */
  x: number;
  y: number;
  onChange: (patch: Partial<Pick<Annotation, "title" | "description">>) => void;
  /** Re-snapshot the annotation's full session state (layers, filters, camera). */
  onRecapture: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [title, setTitle] = useState(annotation.title);
  const [description, setDescription] = useState(annotation.description);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Pick<Annotation, "title" | "description">>>({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Selection switched to another annotation: load its text, close the panel.
  useEffect(() => {
    setTitle(annotation.title);
    setDescription(annotation.description);
    pendingRef.current = {};
    setInfoOpen(false);
    setEditingDescription(false);
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

  // Starting a description edit puts the caret in the textarea.
  useEffect(() => {
    if (editingDescription) descriptionRef.current?.focus();
  }, [editingDescription]);

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

  // Flush the pending edit when the chrome closes/unmounts.
  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      const pending = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(pending).length > 0) onChangeRef.current(pending);
    };
  }, []);

  // Clamp to the app root; the stack's bottom sits above the shape's top
  // point (menus grow upward), flipping below it when there is no room above.
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
      className="absolute z-40 flex flex-col items-center gap-2"
      style={{ left: x, top: y - POINTER_OFFSET }}
    >
      {infoOpen && (
        <div className="w-72 rounded-xl bg-white/95 p-3 text-xs text-gray-600 shadow-md backdrop-blur-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 font-semibold text-gray-700">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: annotation.color }}
                  aria-hidden
                />
                {annotation.author}
              </p>
              <p className="text-gray-400">
                {new Date(annotation.createdAt).toLocaleString("nl-NL", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="flex-shrink-0"
              onClick={() => {
                if (editingDescription) commit();
                setEditingDescription((v) => !v);
              }}
              title={
                editingDescription
                  ? "Beschrijving bewerken stoppen"
                  : "Beschrijving bewerken"
              }
              aria-label="Beschrijving bewerken"
              aria-pressed={editingDescription}
            >
              <Icon
                name={editingDescription ? "edit_off" : "edit"}
                size={chromeIconSize()}
                color={editingDescription ? chromeIconColor() : undefined}
                className={editingDescription ? undefined : "text-gray-400"}
              />
            </Button>
          </div>
          {editingDescription ? (
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                queue({ description: e.target.value });
              }}
              onBlur={commit}
              placeholder="Beschrijving of analyse"
              rows={3}
              className="mt-2 w-full resize-none rounded-lg bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow-sm outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
            />
          ) : description ? (
            <p className="mt-2 whitespace-pre-wrap">{description}</p>
          ) : (
            <p className="mt-2 italic text-gray-400">Geen beschrijving</p>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        {/* Titlebox doubles as the title editor — type to rename. */}
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            queue({ title: e.target.value });
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter confirms; keep Escape's deselect behavior after a blur.
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Zonder titel"
          aria-label="Titel van de annotatie"
          className="w-56 rounded-xl bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md outline-none backdrop-blur-sm placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
        />
        <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRecapture}
            title="Kaartstatus opnieuw vastleggen"
            aria-label="Kaartstatus opnieuw vastleggen"
          >
            <Icon
              name="screenshot_frame_2"
              size={chromeIconSize()}
              className="text-gray-400"
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setInfoOpen((v) => !v)}
            title="Annotatie-informatie"
            aria-label="Annotatie-informatie"
            aria-expanded={infoOpen}
          >
            <Icon
              name="info"
              size={chromeIconSize()}
              color={infoOpen ? chromeIconColor() : undefined}
              className={infoOpen ? undefined : "text-gray-400"}
            />
          </Button>
        </div>
      </div>
    </div>
  );
}
