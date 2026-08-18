import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { getCollabIdentity, type CollabIdentity } from "@/lib/collab-identity";
import type { CollabPresence } from "@/types/annotation";

/** Minimum interval between cursor awareness broadcasts (≈25 Hz). */
const CURSOR_THROTTLE_MS = 40;

/**
 * WebSocket endpoint of the collab server. Same-origin `/collab` in
 * production (nginx proxies it to the localhost Hocuspocus daemon, so the
 * host's TLS cert covers wss); `VITE_COLLAB_WS_URL` overrides for dev setups
 * without the vite proxy.
 */
function collabWsUrl(): string {
  const override = import.meta.env.VITE_COLLAB_WS_URL as string | undefined;
  if (override) return override;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/collab`;
}

export interface CollabState {
  /** Joined room id (UUID), or null while the session is local-only. */
  roomId: Accessor<string | null>;
  connected: Accessor<boolean>;
  /** Remote participants' presence (self excluded). */
  peers: Accessor<CollabPresence[]>;
  /** Connect the session doc to a room. No-op when already in that room. */
  startSession(roomId: string): void;
  /** Broadcast the local cursor (throttled); null = pointer left the map. */
  setCursor(pos: { lng: number; lat: number } | null): void;
  /** Broadcast which annotation is selected locally (peer highlight). */
  setActiveAnnotation(id: string | null): void;
  identity: CollabIdentity;
}

/**
 * Collaboration lifecycle for the annotation session: attaches a Hocuspocus
 * provider to the shared Y.Doc when a room is joined, and bridges the Yjs
 * Awareness protocol (live cursors, selection highlights) into signals.
 * Cursors are ephemeral awareness state — never stored in the doc.
 */
export function useCollab(doc: Y.Doc): CollabState {
  const [roomId, setRoomId] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [peers, setPeers] = createSignal<CollabPresence[]>([]);
  const identity = getCollabIdentity();

  // None of the following is rendered, so all of it is plain local state.
  let provider: HocuspocusProvider | null = null;
  // Cursor throttle: remember the latest position, send at most every 40 ms
  // (trailing edge so the final resting position always goes out).
  let cursor: { lng: number; lat: number } | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorLastSent = 0;
  // Awareness updates arrive one per message; coalesce everything that lands in
  // the same frame into a single peers update.
  let peersRaf: number | null = null;

  function startSession(nextRoomId: string) {
    if (provider) {
      if (roomId() === nextRoomId) return;
      provider.destroy();
      provider = null;
    }
    const next = new HocuspocusProvider({
      url: collabWsUrl(),
      name: nextRoomId,
      document: doc,
      onStatus: ({ status }) => setConnected(status === "connected"),
      onAwarenessChange: ({ states }) => {
        if (peersRaf !== null) return;
        peersRaf = requestAnimationFrame(() => {
          peersRaf = null;
          const self = next.awareness?.clientID;
          setPeers(
            states
              .filter((s) => s.clientId !== self && s.user)
              .map((s) => ({
                user: s.user,
                cursor: s.cursor ?? null,
                activeAnnotationId: s.activeAnnotationId ?? null,
              })),
          );
        });
      },
    });
    next.setAwarenessField("user", identity);
    next.setAwarenessField("cursor", null);
    next.setAwarenessField("activeAnnotationId", null);
    provider = next;
    setRoomId(nextRoomId);
  }

  function setCursor(pos: { lng: number; lat: number } | null) {
    cursor = pos;
    if (!provider) return;
    if (cursorTimer !== null) return; // trailing send already queued
    function send() {
      cursorLastSent = performance.now();
      provider?.setAwarenessField("cursor", cursor);
    }
    const elapsed = performance.now() - cursorLastSent;
    if (elapsed >= CURSOR_THROTTLE_MS) {
      send();
    } else {
      cursorTimer = setTimeout(() => {
        cursorTimer = null;
        send();
      }, CURSOR_THROTTLE_MS - elapsed);
    }
  }

  function setActiveAnnotation(id: string | null) {
    provider?.setAwarenessField("activeAnnotationId", id);
  }

  // Clear the broadcast cursor when the pointer leaves the page or the tab
  // loses focus — otherwise peers see it frozen at the last map position.
  createEffect(() => {
    if (!roomId()) return;
    function clear() {
      setCursor(null);
    }
    document.documentElement.addEventListener("mouseleave", clear);
    window.addEventListener("blur", clear);
    onCleanup(() => {
      document.documentElement.removeEventListener("mouseleave", clear);
      window.removeEventListener("blur", clear);
    });
  });

  // Destroy the provider on teardown (awareness auto-clears for peers). App
  // never unmounts in practice; this covers dev teardown.
  onCleanup(() => {
    if (cursorTimer !== null) clearTimeout(cursorTimer);
    if (peersRaf !== null) cancelAnimationFrame(peersRaf);
    provider?.destroy();
    provider = null;
  });

  return {
    roomId,
    connected,
    peers,
    startSession,
    setCursor,
    setActiveAnnotation,
    identity,
  };
}
