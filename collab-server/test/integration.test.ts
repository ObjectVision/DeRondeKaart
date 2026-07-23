/**
 * End-to-end check that the real server (createCollabServer) persists valid
 * rooms and — critically — does NOT persist oversized/invalid ones, against an
 * on-disk SQLite file. Documents are driven via Hocuspocus's server-side
 * DirectConnection (no WebSocket client needed); the full onStoreDocument hook
 * chain runs, so this exercises the guard-extension-before-SQLite ordering that
 * the whole P0/P1 design depends on.
 *
 * Caps are tightened via env set BEFORE importing config, so the run is fast.
 * Run with --test-force-exit (see package.json) — the Hocuspocus server keeps
 * listener handles open that would otherwise hold `node --test` after `after()`.
 */

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Document } from "@hocuspocus/server";

const dir = mkdtempSync(join(tmpdir(), "collab-it-"));
const dbPath = join(dir, "annotations.db");

process.env.PORT = "0"; // ephemeral port
process.env.MAX_ANNOTATIONS = "3";

const { createCollabServer } = await import("../src/server.js");
const { limits } = await import("../src/config.js");

const ANNOTATIONS_KEY = "annotations";
const OK_ROOM = "11111111-1111-4111-8111-111111111111";
const BIG_ROOM = "22222222-2222-4222-8222-222222222222";

const { server, startStorage, stopStorage } = createCollabServer(dbPath);
await server.listen();
startStorage();

after(async () => {
  stopStorage();
  await server.destroy();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may briefly hold the file handle */
  }
});

/** Run the full store hook chain immediately (guard → SQLite). The chain
 * catches a guard throw internally, so we assert on what reached disk, not on
 * whether this rejects. */
async function store(room: string): Promise<void> {
  const doc = server.hocuspocus.documents.get(room)!;
  await server.hocuspocus.storeDocumentHooks(
    doc,
    { document: doc, documentName: room, instance: server.hocuspocus } as never,
    true,
  );
}

function query<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function roomRows(room: string): number {
  return query(
    (db) =>
      (db.prepare(`SELECT COUNT(*) c FROM documents WHERE name = ?`).get(room) as { c: number }).c,
  );
}

test("persists a valid room to SQLite", async () => {
  const conn = await server.hocuspocus.openDirectConnection(OK_ROOM);
  await conn.transact((doc: Document) => {
    doc.getMap(ANNOTATIONS_KEY).set("a", { title: "ok", description: "", snapshot: {} });
  });
  await store(OK_ROOM);
  await conn.disconnect();
  assert.equal(roomRows(OK_ROOM), 1);
});

test("records room activity in the sidecar table on a valid store", () => {
  const row = query(
    (db) =>
      db.prepare(`SELECT updated_at FROM room_activity WHERE name = ?`).get(OK_ROOM) as
        | { updated_at: number }
        | undefined,
  );
  assert.ok(row && row.updated_at > 0, "expected a room_activity row for the stored room");
});

test("does NOT persist a room over the annotation-count cap", async () => {
  const conn = await server.hocuspocus.openDirectConnection(BIG_ROOM);
  await conn.transact((doc: Document) => {
    const map = doc.getMap(ANNOTATIONS_KEY);
    for (let i = 0; i < limits.maxAnnotations + 2; i++) {
      map.set(`a${i}`, { title: "x", description: "", snapshot: {} });
    }
  });
  await store(BIG_ROOM);
  await conn.disconnect();
  // The guard runs before SQLite and throws → the write is aborted.
  assert.equal(roomRows(BIG_ROOM), 0);
});

test("db file exists on disk", () => {
  assert.ok(existsSync(dbPath));
});
