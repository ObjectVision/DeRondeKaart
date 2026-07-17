import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  roomId: string | null;
  connected: boolean;
  /** Remote participants' presence (self excluded). */
  peers: CollabPresence[];
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
 * Awareness protocol (live cursors, selection highlights) to React state.
 * Cursors are ephemeral awareness state — never stored in the doc.
 */
export function useCollab(doc: Y.Doc): CollabState {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabPresence[]>([]);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const identity = useMemo(() => getCollabIdentity(), []);

  // Cursor throttle: remember the latest position, send at most every 40 ms
  // (trailing edge so the final resting position always goes out).
  const cursorRef = useRef<{ lng: number; lat: number } | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorLastSentRef = useRef(0);

  // Awareness updates arrive per-message; batch the React mirror per frame so
  // several peers at 25 Hz don't trigger hundreds of re-renders per second.
  const peersRafRef = useRef<number | null>(null);

  const startSession = useCallback(
    (nextRoomId: string) => {
      if (providerRef.current) {
        if (roomId === nextRoomId) return;
        providerRef.current.destroy();
        providerRef.current = null;
      }
      const provider = new HocuspocusProvider({
        url: collabWsUrl(),
        name: nextRoomId,
        document: doc,
        onStatus: ({ status }) => setConnected(status === "connected"),
        onAwarenessChange: ({ states }) => {
          if (peersRafRef.current !== null) return;
          peersRafRef.current = requestAnimationFrame(() => {
            peersRafRef.current = null;
            const self = provider.awareness?.clientID;
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
      provider.setAwarenessField("user", identity);
      provider.setAwarenessField("cursor", null);
      provider.setAwarenessField("activeAnnotationId", null);
      providerRef.current = provider;
      setRoomId(nextRoomId);
    },
    [doc, identity, roomId],
  );

  const setCursor = useCallback((pos: { lng: number; lat: number } | null) => {
    cursorRef.current = pos;
    const provider = providerRef.current;
    if (!provider) return;
    if (cursorTimerRef.current !== null) return; // trailing send already queued
    const send = () => {
      cursorLastSentRef.current = performance.now();
      providerRef.current?.setAwarenessField("cursor", cursorRef.current);
    };
    const elapsed = performance.now() - cursorLastSentRef.current;
    if (elapsed >= CURSOR_THROTTLE_MS) {
      send();
    } else {
      cursorTimerRef.current = setTimeout(() => {
        cursorTimerRef.current = null;
        send();
      }, CURSOR_THROTTLE_MS - elapsed);
    }
  }, []);

  const setActiveAnnotation = useCallback((id: string | null) => {
    providerRef.current?.setAwarenessField("activeAnnotationId", id);
  }, []);

  // Clear the broadcast cursor when the pointer leaves the page or the tab
  // loses focus — otherwise peers see it frozen at the last map position.
  useEffect(() => {
    if (!roomId) return;
    const clear = () => setCursor(null);
    document.documentElement.addEventListener("mouseleave", clear);
    window.addEventListener("blur", clear);
    return () => {
      document.documentElement.removeEventListener("mouseleave", clear);
      window.removeEventListener("blur", clear);
    };
  }, [roomId, setCursor]);

  // Destroy the provider on unmount (awareness auto-clears for peers). App
  // never unmounts in practice; this covers StrictMode/dev teardown.
  useEffect(() => {
    return () => {
      if (cursorTimerRef.current !== null) clearTimeout(cursorTimerRef.current);
      if (peersRafRef.current !== null) cancelAnimationFrame(peersRafRef.current);
      providerRef.current?.destroy();
      providerRef.current = null;
    };
  }, []);

  return useMemo(
    () => ({
      roomId,
      connected,
      peers,
      startSession,
      setCursor,
      setActiveAnnotation,
      identity,
    }),
    [roomId, connected, peers, startSession, setCursor, setActiveAnnotation, identity],
  );
}
