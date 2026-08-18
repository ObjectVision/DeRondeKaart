import { createSignal, onMount, onCleanup, type Accessor } from "solid-js";
import * as Y from "yjs";
import type { Annotation } from "@/types/annotation";

/** Name of the shared map inside the session Y.Doc. */
const ANNOTATIONS_KEY = "annotations";

export interface AnnotationsState {
  /** All annotations, oldest first (stable render/legend order). */
  annotations: Accessor<Annotation[]>;
  add(annotation: Annotation): void;
  update(id: string, patch: Partial<Annotation>): void;
  remove(id: string): void;
  /** The session document — handed to use-collab when a room is joined. */
  doc: Y.Doc;
}

/**
 * The annotation store: a Y.Map (keyed by annotation id, plain-JSON values)
 * mirrored into a signal. The Y.Doc exists from mount; "local mode" is simply
 * the doc without a provider. Joining a collab room later just attaches a
 * provider to this same doc — Yjs's initial sync then merges the local
 * annotations into the room (ids are UUIDs, so no collisions).
 *
 * Edits replace the whole per-id value (last-writer-wins per annotation);
 * concurrent edits to the *same* annotation clobber each other — accepted for
 * v1 (the awareness `activeAnnotationId` highlight mitigates in practice).
 */
export function useAnnotations(): AnnotationsState {
  // Stable doc for the app's lifetime, deliberately never destroyed: App never
  // unmounts. (React additionally had to guard against StrictMode's double
  // invocation destroying the doc the second mount still used — Solid has no
  // equivalent, so the doc is simply constructed once here.)
  const doc = new Y.Doc();
  const [annotations, setAnnotations] = createSignal<Annotation[]>([]);

  onMount(() => {
    const yMap = doc.getMap<Annotation>(ANNOTATIONS_KEY);
    function mirror() {
      setAnnotations([...yMap.values()].sort((a, b) => a.createdAt - b.createdAt));
    }
    mirror();
    yMap.observe(mirror);
    onCleanup(() => yMap.unobserve(mirror));
  });

  function add(annotation: Annotation) {
    doc.getMap<Annotation>(ANNOTATIONS_KEY).set(annotation.id, annotation);
  }

  function update(id: string, patch: Partial<Annotation>) {
    const yMap = doc.getMap<Annotation>(ANNOTATIONS_KEY);
    const current = yMap.get(id);
    if (!current) return; // deleted by a peer mid-edit
    yMap.set(id, { ...current, ...patch, id });
  }

  function remove(id: string) {
    doc.getMap<Annotation>(ANNOTATIONS_KEY).delete(id);
  }

  return { annotations, add, update, remove, doc };
}
