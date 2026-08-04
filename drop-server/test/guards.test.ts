/**
 * Unit tests for the request-independent guards: filename hygiene (P1),
 * the per-IP rate limiter (P2), and public-key validation at boot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeFilename } from "../src/sanitize.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { publicKey } from "../src/config.js";

test("sanitizeFilename strips path separators and Windows-forbidden chars", () => {
  assert.equal(sanitizeFilename("..%2F..%2Fetc%2Fpasswd"), "_.._etc_passwd");
  assert.equal(sanitizeFilename("a%5Cb%3Ac%2Ax%3F.txt"), "a_b_c_x_.txt");
});

test("sanitizeFilename removes control characters and leading dots", () => {
  assert.equal(sanitizeFilename("%0A%0Dreport%00.xlsx"), "report.xlsx");
  assert.equal(sanitizeFilename("...hidden"), "hidden");
});

test("sanitizeFilename tolerates malformed percent-encoding", () => {
  assert.equal(sanitizeFilename("%E0%ZZ"), "");
});

test("sanitizeFilename caps length", () => {
  assert.equal(sanitizeFilename("x".repeat(500)).length, 200);
});

test("sanitizeFilename passes ordinary names through", () => {
  assert.equal(sanitizeFilename("begroting%202026.xlsx"), "begroting 2026.xlsx");
  assert.equal(sanitizeFilename(undefined), "");
});

test("rate limiter blocks the (max+1)th drop and recovers after the window", () => {
  let clock = 0;
  const limiter = new RateLimiter(60_000, 3, () => clock);

  assert.equal(limiter.record("1.2.3.4").allowed, true);
  assert.equal(limiter.record("1.2.3.4").allowed, true);
  assert.equal(limiter.record("1.2.3.4").allowed, true);
  const blocked = limiter.record("1.2.3.4");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /4 drops/);

  // Another IP is unaffected.
  assert.equal(limiter.record("5.6.7.8").allowed, true);

  // A new window resets the budget.
  clock += 60_000;
  assert.equal(limiter.record("1.2.3.4").allowed, true);
});

test("publicKey() rejects missing, non-base64 and wrong-length keys", () => {
  const original = process.env.DROP_PUBLIC_KEY;
  try {
    delete process.env.DROP_PUBLIC_KEY;
    assert.throws(() => publicKey(), /DROP_PUBLIC_KEY/);

    process.env.DROP_PUBLIC_KEY = "not base64!!";
    assert.throws(() => publicKey(), /DROP_PUBLIC_KEY/);

    process.env.DROP_PUBLIC_KEY = Buffer.alloc(16).toString("base64"); // 16 bytes, not 32
    assert.throws(() => publicKey(), /DROP_PUBLIC_KEY/);

    const valid = Buffer.alloc(32, 7).toString("base64");
    process.env.DROP_PUBLIC_KEY = valid;
    assert.equal(publicKey(), valid);
  } finally {
    if (original === undefined) delete process.env.DROP_PUBLIC_KEY;
    else process.env.DROP_PUBLIC_KEY = original;
  }
});
