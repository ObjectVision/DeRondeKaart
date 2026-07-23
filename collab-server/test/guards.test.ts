/**
 * Verification for the overload/storage guards. Run with:
 *   npm run build && node --test dist-test/
 * (see package.json "test" script). Uses node:test + node:assert — no extra deps.
 *
 * Covers: P1 content validation, P0 doc-size gate, P2 rate limiter, and the P3
 * TTL garbage collection against a real in-memory better-sqlite3 database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { limits } from "../src/config.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { Storage, type SqliteDb } from "../src/storage.js";
import { validateAnnotations, validateDocSize } from "../src/validate.js";

// --- P1: content validation ---------------------------------------------------

test("accepts a normal annotation set", () => {
  const entries = [
    { title: "Site A", description: "notes", points: [1, 2, 3], snapshot: { a: 1 } },
    { title: "Site B", description: "", snapshot: {} },
  ];
  assert.equal(validateAnnotations(entries, limits).ok, true);
});

test("rejects when annotation count exceeds the cap", () => {
  const entries = Array.from({ length: limits.maxAnnotations + 1 }, () => ({ title: "x" }));
  const r = validateAnnotations(entries, limits);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /count/);
});

test("rejects over-long title and description", () => {
  const longTitle = "a".repeat(limits.maxTitleLen + 1);
  assert.equal(validateAnnotations([{ title: longTitle }], limits).ok, false);
  const longDesc = "a".repeat(limits.maxDescLen + 1);
  assert.equal(validateAnnotations([{ description: longDesc }], limits).ok, false);
});

test("rejects a polygon with too many vertices", () => {
  const points = Array.from({ length: limits.maxPolyPoints + 1 }, (_, i) => i);
  assert.equal(validateAnnotations([{ points }], limits).ok, false);
});

test("rejects an oversized embedded snapshot", () => {
  const snapshot = { blob: "x".repeat(limits.maxSnapshotBytes + 10) };
  const r = validateAnnotations([{ snapshot }], limits);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /snapshot/);
});

// --- P0: doc-size gate --------------------------------------------------------

test("doc-size gate accepts under and rejects over the cap", () => {
  assert.equal(validateDocSize(limits.maxDocBytes, limits).ok, true);
  assert.equal(validateDocSize(limits.maxDocBytes + 1, limits).ok, false);
});

// --- P2: rate limiter ---------------------------------------------------------

test("rate limiter trips on byte volume within the window", () => {
  let now = 1_000;
  const rl = new RateLimiter(10_000, 1_000, 1_000_000, () => now);
  assert.equal(rl.record("s1", 600).allowed, true);
  assert.equal(rl.record("s1", 600).allowed, false); // 1200 > 1000
});

test("rate limiter trips on message count within the window", () => {
  let now = 1_000;
  const rl = new RateLimiter(10_000, 1_000_000, 3, () => now);
  assert.equal(rl.record("s1", 1).allowed, true);
  assert.equal(rl.record("s1", 1).allowed, true);
  assert.equal(rl.record("s1", 1).allowed, true);
  assert.equal(rl.record("s1", 1).allowed, false); // 4th msg > 3
});

test("rate limiter resets after the window elapses", () => {
  let now = 1_000;
  const rl = new RateLimiter(10_000, 1_000, 1_000_000, () => now);
  assert.equal(rl.record("s1", 900).allowed, true);
  now += 10_001; // window rolled over
  assert.equal(rl.record("s1", 900).allowed, true);
});

test("rate limiter tracks connections independently", () => {
  let now = 1_000;
  const rl = new RateLimiter(10_000, 1_000, 1_000_000, () => now);
  assert.equal(rl.record("s1", 1_100).allowed, false);
  assert.equal(rl.record("s2", 100).allowed, true);
});

// --- P3: TTL garbage collection ----------------------------------------------

function seedDb(): { db: Database.Database; sqlite: SqliteDb } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE "documents" ("name" TEXT NOT NULL, "data" BLOB NOT NULL, UNIQUE(name))`,
  );
  return { db, sqlite: db as unknown as SqliteDb };
}

test("GC deletes idle rooms, keeps active and fresh ones", () => {
  const { db, sqlite } = seedDb();
  let now = 1_000_000_000_000;
  const storage = new Storage(sqlite, ":memory:", () => now);

  const ins = db.prepare(`INSERT INTO "documents" (name, data) VALUES (?, ?)`);
  for (const name of ["idle", "fresh", "active"]) ins.run(name, Buffer.from([1]));

  // idle & active last touched now; fresh touched now too.
  storage.touch("idle");
  storage.touch("fresh");
  storage.touch("active");

  // Jump past the TTL, then re-touch only "fresh".
  now += limits.roomTtlDays * 24 * 60 * 60 * 1000 + 60_000;
  storage.touch("fresh");

  // "active" is idle by timestamp but currently connected → must be kept.
  const deleted = storage.runGc(["active"]);

  const remaining = db
    .prepare(`SELECT name FROM "documents" ORDER BY name`)
    .all()
    .map((r: any) => r.name);
  assert.equal(deleted, 1);
  assert.deepEqual(remaining, ["active", "fresh"]);
  db.close();
});

test("GC leaves rooms without an activity row untouched", () => {
  const { db, sqlite } = seedDb();
  let now = 1_000_000_000_000;
  const storage = new Storage(sqlite, ":memory:", () => now);

  db.prepare(`INSERT INTO "documents" (name, data) VALUES (?, ?)`).run(
    "legacy",
    Buffer.from([1]),
  );
  // No touch() for "legacy" — predates the activity table.
  now += limits.roomTtlDays * 24 * 60 * 60 * 1000 + 60_000;

  assert.equal(storage.runGc(), 0);
  const count = (db.prepare(`SELECT COUNT(*) c FROM "documents"`).get() as any).c;
  assert.equal(count, 1);
  db.close();
});
