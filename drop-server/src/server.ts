/**
 * The HTTP surface: three routes on a bare node:http server.
 *
 *   POST /drop         — accept one sealed-box ciphertext, store it, 201 + id
 *   GET  /drop/pubkey  — the public key uploads must be sealed to
 *   GET  /drop/healthz — liveness for systemd/monitoring
 *
 * When the drop is closed (see gate.ts) the first two answer 503 while healthz
 * stays 200 — a deliberate close is not an outage and must not page anyone.
 *
 * Upload-only by construction: there is no route that reads a stored drop
 * back out. The server cannot decrypt what it stores (it only ever holds the
 * public key), so a compromise of this process or its disk discloses nothing.
 *
 * No framework and no multipart: the body is the raw ciphertext
 * (application/octet-stream) and the advisory filename travels in the
 * X-Drop-Filename header, percent-encoded. That keeps parsing surface near
 * zero on a service that faces the open internet.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { limits } from "./config.js";
import { readGate } from "./gate.js";
import { RateLimiter } from "./rate-limiter.js";
import { sanitizeFilename } from "./sanitize.js";
import type { Storage } from "./storage.js";

export interface DropServerOptions {
  storage: Storage;
  publicKeyB64: string;
  rateLimiter?: RateLimiter;
  /** Data dir the gate file is resolved against; defaults to config's. */
  dataDir?: string;
}

/** Hint for clients backing off a closed drop (tools/drop_encrypt.py, curl). */
const CLOSED_RETRY_AFTER = "3600";

function send(
  res: ServerResponse,
  status: number,
  body: object,
  extraHeaders: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    // Belt-and-braces on an internet-facing endpoint; nginx adds the rest.
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(json);
}

/**
 * Client IP for rate limiting. Trusts X-Forwarded-For only because the
 * service binds 127.0.0.1 behind nginx — anything reaching it locally could
 * fake the header anyway, and remotely it always carries the real peer.
 */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function createDropServer(opts: DropServerOptions): Server {
  const rate = opts.rateLimiter ?? new RateLimiter();

  return createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    // Per-request so `drop-toggle` takes effect without a restart.
    const closed = readGate(opts.dataDir);

    if (url === "/drop/healthz" && req.method === "GET") {
      // Always 200: a closed drop is a healthy process, not a failure.
      return send(res, 200, {
        ok: true,
        accepting: closed === null,
        storedBytes: opts.storage.storedBytes,
      });
    }

    if (url === "/drop/pubkey" && req.method === "GET") {
      // Withholding the key is what disarms the upload page.
      if (closed) {
        return send(
          res,
          503,
          { error: "closed", reason: closed.reason },
          { "Retry-After": CLOSED_RETRY_AFTER },
        );
      }
      return send(res, 200, { publicKey: opts.publicKeyB64, algorithm: "x25519-sealedbox" });
    }

    if (url !== "/drop") {
      return send(res, 404, { error: "not found" });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, { error: "method not allowed" });
    }

    // ---- POST /drop ----

    // Before the rate limiter and before a single body byte is read: a closed
    // server must never buffer an upload it has already decided to discard.
    if (closed) {
      return send(
        res,
        503,
        { error: "closed", reason: closed.reason },
        { "Retry-After": CLOSED_RETRY_AFTER },
      );
    }

    const decision = rate.record(clientIp(req));
    if (!decision.allowed) {
      console.warn(`[drop] rate-limited ${clientIp(req)}: ${decision.reason}`);
      return send(res, 429, { error: "too many uploads; wait a minute" });
    }

    const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
    if (type !== "application/octet-stream") {
      return send(res, 415, { error: "content-type must be application/octet-stream" });
    }

    const declared = Number(req.headers["content-length"]);
    if (!Number.isInteger(declared) || declared <= 0) {
      return send(res, 411, { error: "content-length required" });
    }
    if (declared > limits.maxDropBytes) {
      return send(res, 413, { error: `file too large (max ${limits.maxDropBytes} bytes)` });
    }
    if (declared < limits.minDropBytes) {
      // Shorter than sealed-box overhead: cannot be a valid ciphertext.
      return send(res, 400, { error: "body too short to be a sealed box" });
    }
    if (!opts.storage.hasRoomFor(declared)) {
      console.warn(`[drop] storage full: refused ${declared}B upload`);
      return send(res, 507, { error: "storage full; contact the administrator" });
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      // A client whose stream exceeds its declared length is lying; cut it
      // off rather than buffering unbounded data.
      if (received > declared) {
        aborted = true;
        send(res, 400, { error: "body exceeds declared content-length" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      if (received !== declared) {
        return send(res, 400, { error: "body shorter than declared content-length" });
      }
      const filename = sanitizeFilename(
        Array.isArray(req.headers["x-drop-filename"])
          ? req.headers["x-drop-filename"][0]
          : req.headers["x-drop-filename"],
      );
      opts.storage
        .store(Buffer.concat(chunks), filename)
        .then((id) => {
          console.log(`[drop] stored ${id} (${received}B${filename ? `, "${filename}"` : ""})`);
          send(res, 201, { id });
        })
        .catch((err) => {
          console.error("[drop] store failed:", err);
          send(res, 500, { error: "storage failure" });
        });
    });

    req.on("error", () => {
      aborted = true;
    });
  });
}
