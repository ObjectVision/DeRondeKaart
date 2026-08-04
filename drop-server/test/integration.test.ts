/**
 * Integration tests: a real HTTP server on an ephemeral port with a temp data
 * dir, exercising every rejection path and the success path end to end.
 *
 * Limits are shrunk via env BEFORE importing src modules (config reads env at
 * import time; each test file runs in its own process under `node --test`).
 * The env must be set in a module imported first — see env-setup.ts.
 */

import "./env-setup.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createDropServer } from "../src/server.js";
import { Storage } from "../src/storage.js";
import { RateLimiter } from "../src/rate-limiter.js";

const PUBKEY = Buffer.alloc(32, 7).toString("base64");

let dir: string;
let server: Server;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "drop-test-"));
  server = createDropServer({
    storage: new Storage(dir),
    publicKeyB64: PUBKEY,
    rateLimiter: new RateLimiter(60_000, 100),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/drop`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
}

test("healthz responds", async () => {
  const res = await fetch(`${base}/drop/healthz`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean };
  assert.equal(json.ok, true);
});

test("pubkey endpoint serves the configured key", async () => {
  const res = await fetch(`${base}/drop/pubkey`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { publicKey: string; algorithm: string };
  assert.equal(json.publicKey, PUBKEY);
  assert.equal(json.algorithm, "x25519-sealedbox");
});

test("unknown path is 404, wrong method is 405", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const res = await fetch(`${base}/drop`, { method: "GET" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("wrong content type is 415", async () => {
  const res = await fetch(`${base}/drop`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hello there, this is long enough",
  });
  assert.equal(res.status, 415);
});

test("oversize declared length is 413", async () => {
  const res = await post(new Uint8Array(2048));
  assert.equal(res.status, 413);
});

test("body shorter than sealed-box overhead is 400", async () => {
  const res = await post(new Uint8Array(16));
  assert.equal(res.status, 400);
});

test("successful upload stores blob + sidecar with matching sha256", async () => {
  const body = new Uint8Array(100).map((_, i) => i);
  const res = await post(body, { "X-Drop-Filename": encodeURIComponent("kwartaal cijfers.xlsx") });
  assert.equal(res.status, 201);
  const { id } = (await res.json()) as { id: string };
  assert.match(id, /^[0-9a-f-]{36}$/);

  const blob = readFileSync(join(dir, `${id}.bin`));
  assert.deepEqual(new Uint8Array(blob), body);

  const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as {
    size: number;
    sha256: string;
    filename: string;
    receivedAt: string;
  };
  assert.equal(meta.size, 100);
  assert.equal(meta.sha256, createHash("sha256").update(blob).digest("hex"));
  assert.equal(meta.filename, "kwartaal cijfers.xlsx");
  assert.ok(!Number.isNaN(Date.parse(meta.receivedAt)));
});

test("no .part files remain after uploads", () => {
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".part")).length, 0);
});

test("rate limit returns 429 (dedicated server with a strict limiter)", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "drop-test-rate-"));
  const strict = createDropServer({
    storage: new Storage(dir2),
    publicKeyB64: PUBKEY,
    rateLimiter: new RateLimiter(60_000, 2),
  });
  await new Promise<void>((resolve) => strict.listen(0, "127.0.0.1", resolve));
  const addr = strict.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  const strictBase = `http://127.0.0.1:${addr.port}`;

  try {
    const send = () =>
      fetch(`${strictBase}/drop`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(64),
      });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 429);
  } finally {
    strict.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("storage full is 507 and stops accepting", async () => {
  // Cap is 5000B; fill it with uploads until the guard trips, then confirm.
  let sawFull = false;
  for (let i = 0; i < 60; i++) {
    const res = await post(new Uint8Array(512));
    if (res.status === 507) {
      sawFull = true;
      break;
    }
    assert.equal(res.status, 201);
  }
  assert.equal(sawFull, true, "expected a 507 once the storage cap was hit");
  // And it stays refused.
  assert.equal((await post(new Uint8Array(512))).status, 507);
});
