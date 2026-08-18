import { createEffect, createSignal, type Accessor } from "solid-js";

/**
 * State behind the "Delen" (share/export) dialog and the bare circular-only
 * view, plus the rule that promotes a local annotation session to a shared
 * collaborative room when the dialog opens.
 *
 * Title/subtitle live here rather than inside `ShareDialog` because a host
 * `open-circular` message can prefill them before the dialog ever mounts.
 */
export interface UseShareStateOptions {
  /**
   * Sharing may be turned off by configuration; `openCircular` then no-ops.
   * Accessors, not plain values: an embedding host can flip both at runtime
   * through the `map-config` message.
   */
  shareEnabled: Accessor<boolean>;
  annotationsEnabled: Accessor<boolean>;
  annotationActive: Accessor<boolean>;
  /** The collab room already joined, or null when the session is still local. */
  collabRoomId: Accessor<string | null>;
  startSession: (roomId: string) => void;
}

export interface UseShareStateResult {
  shareOpen: Accessor<boolean>;
  setShareOpen: (open: boolean) => void;
  circularOpen: Accessor<boolean>;
  setCircularOpen: (open: boolean) => void;
  shareTitle: Accessor<string>;
  setShareTitle: (title: string) => void;
  shareSubtitle: Accessor<string>;
  setShareSubtitle: (subtitle: string) => void;
  /** Handles a host `open-circular` message. */
  openCircular: (opts: { title?: string; subtitle?: string }) => void;
}

export function useShareState(options: UseShareStateOptions): UseShareStateResult {
  const [shareOpen, setShareOpen] = createSignal(false);
  const [circularOpen, setCircularOpen] = createSignal(false);
  const [shareTitle, setShareTitle] = createSignal("");
  const [shareSubtitle, setShareSubtitle] = createSignal("");

  // Sharing while the annotation tool is armed promotes the local session to
  // a collaborative room: mint an unguessable UUID (the room's only access
  // key — see collab-server/README.md) and connect; Yjs sync seeds the local
  // annotations into the fresh room. The id persists for re-shares.
  createEffect(() => {
    if (
      shareOpen() &&
      options.annotationsEnabled() &&
      options.annotationActive() &&
      !options.collabRoomId()
    ) {
      options.startSession(crypto.randomUUID());
    }
  });

  // A host `open-circular` message: prefill the export title/subtitle and show
  // the bare circular-only view — only the circle + legend + title, no map
  // chrome. The layers/view/filter are already reconciled by useUrlCommands
  // before this fires.
  function openCircular({ title, subtitle }: { title?: string; subtitle?: string }) {
    if (!options.shareEnabled()) {
      console.warn("open-circular ignored: sharing is disabled in this configuration");
      return;
    }
    if (title !== undefined) setShareTitle(title);
    if (subtitle !== undefined) setShareSubtitle(subtitle);
    setCircularOpen(true);
  }

  return {
    shareOpen,
    setShareOpen,
    circularOpen,
    setCircularOpen,
    shareTitle,
    setShareTitle,
    shareSubtitle,
    setShareSubtitle,
    openCircular,
  };
}
