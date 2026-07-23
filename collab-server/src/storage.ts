/**
 * Storage lifecycle: room TTL + garbage collection (P3) and size monitoring (P4).
 *
 * The @hocuspocus/extension-sqlite table is `documents(name, data)` with no
 * timestamp, so we keep a sidecar `room_activity(name, updated_at)` table,
 * touched on every store. A periodic job deletes documents whose room has been
 * idle past the TTL, then VACUUMs so freed pages return to the filesystem
 * (without VACUUM the file never shrinks — the core storage-cap concern).
 *
 * We reuse the extension's own better-sqlite3 handle rather than opening a
 * second connection, to avoid write-lock contention. The handle is typed
 * structurally so this module needs no direct better-sqlite3 dependency.
 */

import { statSync } from "node:fs";
import { limits } from "./config.js";

/** Minimal structural view of the better-sqlite3 handle the extension owns. */
export interface SqliteDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

const ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS "room_activity" (
    "name"       TEXT PRIMARY KEY,
    "updated_at" INTEGER NOT NULL
  )`;

export class Storage {
  private touchStmt;
  private gcTimer?: NodeJS.Timeout;

  constructor(
    private readonly db: SqliteDb,
    private readonly dbPath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(ACTIVITY_DDL);
    this.touchStmt = this.db.prepare(
      `INSERT INTO "room_activity" ("name", "updated_at") VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`,
    );
  }

  /** Record that `room` was just written. Called from onStoreDocument. */
  touch(room: string): void {
    this.touchStmt.run(room, this.now());
  }

  /**
   * Delete documents idle past the TTL, plus their activity rows, then VACUUM.
   * `activeRooms` are currently-connected rooms — never GC'd even if the sidecar
   * row is somehow stale. Returns the number of rooms deleted.
   */
  runGc(activeRooms: Iterable<string> = []): number {
    const cutoff = this.now() - limits.roomTtlDays * 24 * 60 * 60 * 1000;
    const active = new Set(activeRooms);

    // Delete documents whose room has an activity row older than the cutoff and
    // isn't currently connected. Rooms with no activity row are left alone —
    // they predate this table and we can't prove their age; the next store
    // gives them a timestamp. The whole predicate runs in SQL, so we never need
    // to materialise the idle list in JS.
    const del = this.db.prepare(
      `DELETE FROM "documents"
         WHERE name IN (SELECT name FROM "room_activity" WHERE updated_at < ?)
           AND name NOT IN (${[...active].map(() => "?").join(",") || "''"})`,
    );
    const res = del.run(cutoff, ...active);

    this.db
      .prepare(
        `DELETE FROM "room_activity"
           WHERE updated_at < ?
             AND name NOT IN (SELECT name FROM "documents")`,
      )
      .run(cutoff);

    if (res.changes > 0) {
      this.db.exec("VACUUM");
    }
    return res.changes;
  }

  /** P4 — log a warning when the DB file exceeds the configured threshold. */
  checkSize(): void {
    try {
      const bytes = statSync(this.dbPath).size;
      if (bytes > limits.dbSizeWarnBytes) {
        console.warn(
          `[storage] SQLite file ${bytes}B exceeds warn threshold ${limits.dbSizeWarnBytes}B (${this.dbPath})`,
        );
      }
    } catch {
      // File may not exist yet on first boot — nothing to check.
    }
  }

  /** Start the periodic GC + size-check timer. `getActiveRooms` supplies the
   * live room set at each tick. Unref'd so it never keeps the process alive. */
  start(getActiveRooms: () => Iterable<string>): void {
    const tick = () => {
      try {
        const deleted = this.runGc(getActiveRooms());
        if (deleted > 0) console.log(`[storage] GC removed ${deleted} idle room(s)`);
      } catch (err) {
        console.error("[storage] GC failed:", err);
      }
      this.checkSize();
    };
    this.gcTimer = setInterval(tick, limits.gcIntervalMs);
    this.gcTimer.unref?.();
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }
}
