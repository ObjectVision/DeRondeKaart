import { useCallback, useEffect, useState } from "react";

/**
 * State behind the "Delen" (share/export) dialog and the bare circular-only
 * view, plus the rule that promotes a local annotation session to a shared
 * collaborative room when the dialog opens.
 *
 * Title/subtitle live here rather than inside `ShareDialog` because a host
 * `open-circular` message can prefill them before the dialog ever mounts.
 */
export interface UseShareStateOptions {
  /** Sharing may be turned off by configuration; `openCircular` then no-ops. */
  shareEnabled: boolean;
  annotationsEnabled: boolean;
  annotationActive: boolean;
  /** The collab room already joined, or null when the session is still local. */
  collabRoomId: string | null;
  startSession: (roomId: string) => void;
}

export interface UseShareStateResult {
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
  circularOpen: boolean;
  setCircularOpen: (open: boolean) => void;
  shareTitle: string;
  setShareTitle: (title: string) => void;
  shareSubtitle: string;
  setShareSubtitle: (subtitle: string) => void;
  /** Handles a host `open-circular` message. */
  openCircular: (opts: { title?: string; subtitle?: string }) => void;
}

export function useShareState({
  shareEnabled,
  annotationsEnabled,
  annotationActive,
  collabRoomId,
  startSession,
}: UseShareStateOptions): UseShareStateResult {
  const [shareOpen, setShareOpen] = useState(false);
  const [circularOpen, setCircularOpen] = useState(false);
  const [shareTitle, setShareTitle] = useState("");
  const [shareSubtitle, setShareSubtitle] = useState("");

  // Sharing while the annotation tool is armed promotes the local session to
  // a collaborative room: mint an unguessable UUID (the room's only access
  // key — see collab-server/README.md) and connect; Yjs sync seeds the local
  // annotations into the fresh room. The id persists for re-shares.
  useEffect(() => {
    if (shareOpen && annotationsEnabled && annotationActive && !collabRoomId) {
      startSession(crypto.randomUUID());
    }
  }, [shareOpen, annotationsEnabled, annotationActive, collabRoomId, startSession]);

  // A host `open-circular` message: prefill the export title/subtitle and show
  // the bare circular-only view — only the circle + legend + title, no map
  // chrome. The layers/view/filter are already reconciled by useUrlCommands
  // before this fires.
  const openCircular = useCallback(
    ({ title, subtitle }: { title?: string; subtitle?: string }) => {
      if (!shareEnabled) {
        console.warn("open-circular ignored: sharing is disabled in this configuration");
        return;
      }
      if (title !== undefined) setShareTitle(title);
      if (subtitle !== undefined) setShareSubtitle(subtitle);
      setCircularOpen(true);
    },
    [shareEnabled],
  );

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
