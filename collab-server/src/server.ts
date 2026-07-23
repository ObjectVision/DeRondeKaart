import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import { limits } from "./config.js";
import { GuardExtension } from "./guard-extension.js";
import { Storage, type SqliteDb } from "./storage.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CollabServer {
  server: Server;
  /** Call after `server.listen()` — wires storage GC/monitoring to the live
   * SQLite handle. No-op (with a warning) if the handle isn't available. */
  startStorage(): void;
  /** Stop the GC timer (tests / graceful shutdown). */
  stopStorage(): void;
}

/**
 * Build the collab Server with all overload/storage guards wired in. Kept
 * separate from the entry point (index.ts) so the exact same wiring is covered
 * by the integration test.
 *
 * The guard extension (P0/P1/P2) is registered with a high `priority` so its
 * `onStoreDocument` runs BEFORE the SQLite persistence extension — a validation
 * throw then aborts the store chain before anything is written to disk. See
 * guard-extension.ts for why config-level hooks can't do this.
 */
export function createCollabServer(database: string): CollabServer {
  const sqlite = new SQLite({ database });
  const guard = new GuardExtension();
  let storage: Storage | undefined;

  const server = new Server({
    address: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 5174),
    // Order in the array doesn't decide execution order — priority does — but
    // listing guard first keeps the intent obvious.
    extensions: [guard, sqlite],

    async onConnect({ documentName }) {
      // Anything that isn't a UUID room id is rejected — no probing arbitrary
      // document names, and no accidental cross-app doc collisions. Order-
      // independent, so it stays a plain config hook.
      if (!UUID_RE.test(documentName)) {
        throw new Error(`Invalid room id: ${documentName}`);
      }
    },
  });

  return {
    server,
    startStorage() {
      // The SQLite extension opens its handle during startup; reuse it for the
      // storage lifecycle so we don't fight over the write lock.
      const db = sqlite.db as unknown as SqliteDb | undefined;
      if (!db) {
        console.warn("[storage] SQLite handle unavailable — TTL/GC disabled");
        return;
      }
      storage = new Storage(db, database);
      guard.storage = storage; // let the store hook record room activity
      storage.start(() => server.hocuspocus.documents.keys());
      storage.checkSize();
      console.log(`[storage] GC every ${limits.gcIntervalMs}ms, room TTL ${limits.roomTtlDays}d`);
    },
    stopStorage() {
      storage?.stop();
    },
  };
}
