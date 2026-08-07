/**
 * The open/close gate: the state file's presence closes the drop, its absence
 * opens it, and an unreadable one fails OPEN.
 *
 * Layout mirrors production: the gate file sits BESIDE the drops directory
 * (`<root>/closed.json` next to `<root>/drops/`), which is why the server is
 * given the drops dir and resolves the gate from its parent.
 */

import "./env-setup.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createDropServer } from "../src/server.js";
import { Storage } from "../src/storage.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { clearGate, gateFile, readGate, writeGate } from "../src/gate.js";

const PUBKEY = Buffer.alloc(32, 7).toString("base64");

let root: string; // the data root — holds closed.json
let drops: string; // <root>/drops — what the service is pointed at
let server: Server;
let base: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "drop-gate-"));
  drops = join(root, "drops");
  mkdirSync(drops, { recursive: true });
  server = createDropServer({
    storage: new Storage(drops),
    publicKeyB64: PUBKEY,
    rateLimiter: new RateLimiter(60_000, 1000),
    dataDir: drops,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => clearGate(drops));

function post(): Promise<Response> {
  return fetch(`${base}/drop`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(64),
  });
}

const blobCount = () => readdirSync(drops).filter((n) => n.endsWith(".bin")).length;

test("gate file sits beside drops/, not inside it", () => {
  assert.equal(gateFile(drops), join(root, "closed.json"));
});

test("open by default: no state file, uploads accepted", async () => {
  assert.equal(readGate(drops), null);
  assert.equal((await fetch(`${base}/drop/pubkey`)).status, 200);
  assert.equal((await post()).status, 201);
});

test("closed: pubkey is 503 with the reason and Retry-After", async () => {
  writeGate("buiten kantooruren", drops);
  const res = await fetch(`${base}/drop/pubkey`);
  assert.equal(res.status, 503);
  assert.ok(res.headers.get("retry-after"));
  const json = (await res.json()) as { error: string; reason: string };
  assert.equal(json.error, "closed");
  assert.equal(json.reason, "buiten kantooruren");
});

test("closed: POST is 503 and nothing reaches disk", async () => {
  const before = blobCount();
  writeGate("dicht", drops);
  const res = await post();
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { error: string }).error, "closed");
  assert.equal(blobCount(), before, "a closed drop must not store anything");
  assert.equal(readdirSync(drops).filter((n) => n.endsWith(".part")).length, 0);
});

test("closed: healthz stays 200 but reports accepting:false", async () => {
  writeGate("", drops);
  const res = await fetch(`${base}/drop/healthz`);
  assert.equal(res.status, 200, "a deliberate close is not an outage");
  const json = (await res.json()) as { ok: boolean; accepting: boolean };
  assert.equal(json.ok, true);
  assert.equal(json.accepting, false);
});

test("healthz reports accepting:true when open", async () => {
  const json = (await (await fetch(`${base}/drop/healthz`)).json()) as { accepting: boolean };
  assert.equal(json.accepting, true);
});

test("reopening restores uploads without a restart", async () => {
  writeGate("tijdelijk", drops);
  assert.equal((await post()).status, 503);
  clearGate(drops);
  assert.equal((await post()).status, 201);
  assert.equal((await fetch(`${base}/drop/pubkey`)).status, 200);
});

test("a malformed state file fails open", async () => {
  writeFileSync(gateFile(drops), "{ not json at all");
  assert.equal(readGate(drops), null);
  assert.equal((await post()).status, 201);
});

test("close with no reason still closes", async () => {
  writeGate("", drops);
  const res = await fetch(`${base}/drop/pubkey`);
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { reason: string }).reason, "");
});

test("state round-trips through the file", () => {
  const written = writeGate("pickup pending", drops);
  const read = readGate(drops);
  assert.deepEqual(read, written);
  assert.ok(!Number.isNaN(Date.parse(written.closedAt)));
});

test("clearGate is idempotent on an already-open drop", () => {
  clearGate(drops);
  clearGate(drops);
  assert.equal(readGate(drops), null);
});
