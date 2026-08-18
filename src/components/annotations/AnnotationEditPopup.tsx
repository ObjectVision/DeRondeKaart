import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
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
 * - delete removes the annotation (same as Delete/Backspace)
 *
 * The info panel stacks above the titlebox row, growing away from the shape.
 */
interface AnnotationEditPopupProps {
  annotation: Annotation;
  /** Projected screen position of the shape's top point (app-root relative). */
  x: number;
  y: number;
  onChange: (patch: Partial<Pick<Annotation, "title" | "description">>) => void;
  /** Re-snapshot the annotation's full session state (layers, filters, camera). */
  onRecapture: () => void;
  /** Delete the annotation (also deselects — the popup unmounts). */
  onDelete: () => void;
}

export function AnnotationEditPopup(props: AnnotationEditPopupProps): JSX.Element {
  let root!: HTMLDivElement;
  let titleInput!: HTMLInputElement;
  let descriptionInput: HTMLTextAreaElement | undefined;
  const [infoOpen, setInfoOpen] = createSignal(false);
  const [editingDescription, setEditingDescription] = createSignal(false);
  // Local drafts, seeded once — App mounts this per annotation id, and the
  // effects below adopt remote edits while the field is not focused.
  /* eslint-disable solid/reactivity -- deliberate one-time seeds; see above */
  const [title, setTitle] = createSignal(props.annotation.title);
  const [description, setDescription] = createSignal(props.annotation.description);
  /* eslint-enable solid/reactivity */
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Partial<Pick<Annotation, "title" | "description">> = {};

  // No "selection switched" reset effect: App mounts this per annotation id, so
  // selecting another annotation re-creates it and every signal above
  // re-initialises from the new props automatically.

  // Remote edits (a peer typing in the same annotation): adopt them unless the
  // local field is focused — the focused editor's keystrokes win locally.
  createEffect(() => {
    const remote = props.annotation.title;
    if (document.activeElement !== titleInput) setTitle(remote);
  });
  createEffect(() => {
    const remote = props.annotation.description;
    if (document.activeElement !== descriptionInput) setDescription(remote);
  });

  // Starting a description edit puts the caret in the textarea.
  createEffect(() => {
    if (editingDescription()) descriptionInput?.focus();
  });

  // Fires from a timer, a blur handler and the cleanup below, and calls the
  // LATEST onChange simply by reading it off props — React needed a ref plus an
  // `eslint-disable react-hooks/refs` to get the same thing.
  function commit() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
    const patch = pending;
    pending = {};
    if (Object.keys(patch).length > 0) props.onChange(patch);
  }

  function queue(patch: Partial<Pick<Annotation, "title" | "description">>) {
    pending = { ...pending, ...patch };
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_DEBOUNCE_MS);
  }

  // Flush the pending edit when the chrome closes/unmounts.
  onCleanup(commit);

  // Clamp to the app root; the stack's bottom sits above the shape's top
  // point (menus grow upward), flipping below it when there is no room above.
  createEffect(() => {
    const x = props.x;
    const y = props.y;
    const parent = root.parentElement;
    if (!parent) return;

    function place() {
      if (!parent) return;
      const width = root.offsetWidth;
      const height = root.offsetHeight;
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
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    }

    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={root}
      class="absolute z-40 flex flex-col items-center gap-2"
      style={{ left: `${props.x}px`, top: `${props.y - POINTER_OFFSET}px` }}
    >
      <Show when={infoOpen()}>
        <div class="w-72 rounded-xl bg-white/95 p-3 text-xs text-gray-600 shadow-md backdrop-blur-sm">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="flex items-center gap-1.5 font-semibold text-gray-700">
                <span
                  class="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ "background-color": props.annotation.color }}
                  aria-hidden
                />
                {props.annotation.author}
              </p>
              <p class="text-gray-400">
                {new Date(props.annotation.createdAt).toLocaleString("nl-NL", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="flex-shrink-0"
              onClick={() => {
                if (editingDescription()) commit();
                setEditingDescription((v) => !v);
              }}
              title={
                editingDescription()
                  ? "Beschrijving bewerken stoppen"
                  : "Beschrijving bewerken"
              }
              aria-label="Beschrijving bewerken"
              aria-pressed={editingDescription()}
            >
              {/* Two literal `name` props rather than one expression: the
                  icon-font subsetter scans for `name="…"` literals. */}
              <Show
                when={editingDescription()}
                fallback={
                  <Icon name="edit" size={chromeIconSize()} class="text-gray-400" />
                }
              >
                <Icon name="edit_off" size={chromeIconSize()} color={chromeIconColor()} />
              </Show>
            </Button>
          </div>
          <Show
            when={editingDescription()}
            fallback={
              <Show
                when={description()}
                fallback={<p class="mt-2 italic text-gray-400">Geen beschrijving</p>}
              >
                <p class="mt-2 whitespace-pre-wrap">{description()}</p>
              </Show>
            }
          >
            <textarea
              ref={descriptionInput}
              value={description()}
              onInput={(e) => {
                setDescription(e.currentTarget.value);
                queue({ description: e.currentTarget.value });
              }}
              onBlur={commit}
              placeholder="Beschrijving of analyse"
              rows={3}
              class="mt-2 w-full resize-none rounded-lg bg-white/95 px-3 py-1.5 text-xs text-gray-700 shadow-sm outline-none ring-1 ring-gray-200 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
            />
          </Show>
        </div>
      </Show>
      <div class="flex items-center gap-1">
        {/* Titlebox doubles as the title editor — type to rename. */}
        <input
          ref={titleInput}
          type="text"
          value={title()}
          onInput={(e) => {
            setTitle(e.currentTarget.value);
            queue({ title: e.currentTarget.value });
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter confirms; keep Escape's deselect behavior after a blur.
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Zonder titel"
          aria-label="Titel van de annotatie"
          class="w-56 rounded-xl bg-white/95 px-3 py-1.5 text-sm font-semibold text-gray-900 shadow-md outline-none backdrop-blur-sm placeholder:font-normal placeholder:text-gray-400 focus:ring-2 focus:ring-blue-300"
        />
        <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onRecapture}
            title="Kaartstatus opnieuw vastleggen"
            aria-label="Kaartstatus opnieuw vastleggen"
          >
            <Icon name="screenshot_frame_2" size={chromeIconSize()} class="text-gray-400" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setInfoOpen((v) => !v)}
            title="Annotatie-informatie"
            aria-label="Annotatie-informatie"
            aria-expanded={infoOpen()}
          >
            <Icon
              name="info"
              size={chromeIconSize()}
              color={infoOpen() ? chromeIconColor() : undefined}
              class={infoOpen() ? undefined : "text-gray-400"}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onDelete}
            title="Annotatie verwijderen"
            aria-label="Annotatie verwijderen"
          >
            <Icon
              name="delete"
              size={chromeIconSize()}
              class="text-gray-400 hover:text-red-500"
            />
          </Button>
        </div>
      </div>
    </div>
  );
}
