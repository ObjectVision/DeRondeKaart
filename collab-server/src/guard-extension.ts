/**
 * Hocuspocus extension that enforces the overload/storage guards.
 *
 * CRITICAL — ordering: Hocuspocus runs `onStoreDocument` across every extension
 * as a sequential promise chain, and a throw aborts the rest of the chain. The
 * SQLite persistence extension does the actual disk write in *its*
 * `onStoreDocument`. So to prevent a bad document from being written, this
 * guard must run BEFORE the SQLite extension. Extensions are sorted by
 * `priority` (higher runs first — see Hocuspocus `configure()`), so we set a
 * high priority and register this extension ahead of SQLite. Validating in the
 * server-config `onStoreDocument` would NOT work: config hooks are appended
 * last, so SQLite would already have written by the time validation throws.
 *
 * Guards:
 *   - beforeHandleMessage: per-connection flood limiter (P2).
 *   - onStoreDocument: oversized (P0) / invalid (P1) rooms throw → the chain
 *     aborts before SQLite writes; valid stores record activity for TTL/GC (P3).
 */

import * as Y from "yjs";
import type {
  Extension,
  onStoreDocumentPayload,
  beforeHandleMessagePayload,
  onDisconnectPayload,
} from "@hocuspocus/server";
import { limits } from "./config.js";
import { RateLimiter } from "./rate-limiter.js";
import type { Storage } from "./storage.js";
import { validateAnnotations, validateDocSize } from "./validate.js";

const ANNOTATIONS_KEY = "annotations";

export class GuardExtension implements Extension {
  /** Above the default 100 so this runs before the SQLite persistence
   * extension in the onStoreDocument chain. */
  priority = 1000;

  private readonly rateLimiter = new RateLimiter();

  /** Set once the SQLite handle is live (see server.ts startStorage). Until
   * then, activity recording is simply skipped. */
  storage?: Storage;

  // P2 — flood guard. Runs before each inbound update is applied; throwing
  // rejects the message, and we close the socket so a runaway client stops
  // rather than retrying in a tight loop.
  async beforeHandleMessage({
    socketId,
    update,
    connection,
    documentName,
  }: beforeHandleMessagePayload): Promise<void> {
    const decision = this.rateLimiter.record(socketId, update.byteLength);
    if (!decision.allowed) {
      console.warn(`[rate] closing ${socketId} on room ${documentName}: ${decision.reason}`);
      connection.close();
      throw new Error(`rate limit exceeded: ${decision.reason}`);
    }
  }

  // P0 + P1 — runs before SQLite's store. Throwing aborts the persist chain so
  // the oversized/invalid document is never written to disk.
  async onStoreDocument({ document, documentName }: onStoreDocumentPayload): Promise<void> {
    const size = Y.encodeStateAsUpdate(document).byteLength;
    const sizeCheck = validateDocSize(size, limits);
    if (!sizeCheck.ok) {
      console.warn(`[store] rejecting room ${documentName}: ${sizeCheck.reason}`);
      throw new Error(`document rejected: ${sizeCheck.reason}`);
    }

    const entries = [...document.getMap(ANNOTATIONS_KEY).values()];
    const contentCheck = validateAnnotations(entries as never[], limits);
    if (!contentCheck.ok) {
      console.warn(`[store] rejecting room ${documentName}: ${contentCheck.reason}`);
      throw new Error(`document rejected: ${contentCheck.reason}`);
    }

    // Validated — this room is active; record it for TTL/GC (P3). Runs before
    // the disk write, so activity ≈ "a valid write was accepted".
    this.storage?.touch(documentName);
  }

  async onDisconnect({ socketId }: onDisconnectPayload): Promise<void> {
    this.rateLimiter.forget(socketId);
  }
}
