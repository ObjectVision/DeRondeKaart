/**
 * Full round trip with real cryptography: generate a keypair, seal a payload
 * with libsodium (the exact library the browser page uses), POST it, read the
 * stored blob back off disk, open the sealed box, and compare bytes.
 *
 * This proves the wire format end to end in one language; the Python side
 * (tools/drop_encrypt.py / drop_decrypt.py) binds the same libsodium C
 * library, and the cross-language check lives in the verification runbook
 * (drop-server/README.md).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createRequire } from "node:module";
import { createDropServer } from "../src/server.js";
import { Storage } from "../src/storage.js";

// libsodium-wrappers' ESM dist references a file that doesn't resolve under
// Node's ESM loader (0.7.x packaging bug); the CJS build works everywhere.
const require = createRequire(import.meta.url);
const sodium: typeof import("libsodium-wrappers") = require("libsodium-wrappers");

let dir: string;
let server: Server;
let base: string;
let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };

before(async () => {
  await sodium.ready;
  keypair = sodium.crypto_box_keypair();

  dir = mkdtempSync(join(tmpdir(), "drop-roundtrip-"));
  server = createDropServer({
    storage: new Storage(dir),
    publicKeyB64: Buffer.from(keypair.publicKey).toString("base64"),
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

test("seal → POST → stored blob → open → byte-equal", async () => {
  // The client fetches the key from the server, exactly like the page does.
  const pubRes = await fetch(`${base}/drop/pubkey`);
  const { publicKey } = (await pubRes.json()) as { publicKey: string };
  const serverPk = new Uint8Array(Buffer.from(publicKey, "base64"));
  assert.deepEqual(serverPk, keypair.publicKey);

  const plaintext = new Uint8Array(4096);
  for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 31) % 256;

  const sealed = sodium.crypto_box_seal(plaintext, serverPk);
  assert.equal(sealed.length, plaintext.length + sodium.crypto_box_SEALBYTES);

  const res = await fetch(`${base}/drop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Drop-Filename": encodeURIComponent("proef.bin"),
    },
    // Fresh copy: sodium returns Uint8Array<ArrayBufferLike>, which TS won't
    // accept as BodyInit.
    body: new Uint8Array(sealed),
  });
  assert.equal(res.status, 201);
  const { id } = (await res.json()) as { id: string };

  const stored = new Uint8Array(readFileSync(join(dir, `${id}.bin`)));
  assert.deepEqual(stored, sealed, "server must store the ciphertext verbatim");

  const opened = sodium.crypto_box_seal_open(stored, keypair.publicKey, keypair.privateKey);
  assert.deepEqual(opened, plaintext);
});

test("a tampered blob refuses to open", async () => {
  const plaintext = new TextEncoder().encode("vertrouwelijke gegevens");
  const sealed = sodium.crypto_box_seal(plaintext, keypair.publicKey);
  sealed[sealed.length - 1] ^= 0xff; // flip one ciphertext bit

  assert.throws(() =>
    sodium.crypto_box_seal_open(sealed, keypair.publicKey, keypair.privateKey),
  );
});
