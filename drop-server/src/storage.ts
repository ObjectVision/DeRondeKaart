/**
 * Filesystem blob store for sealed drops.
 *
 * Layout: one `<uuid>.bin` (the sealed-box ciphertext, exactly as received)
 * plus one `<uuid>.json` sidecar per drop. Writes go to `<uuid>.part` first
 * and are `rename()`d into place, so a crash mid-upload can never leave a
 * half-blob that looks complete — sweeps delete stray `.part` files.
 *
 * Deliberately NOT a database: blobs are opaque ciphertext, retrieval is
 * `scp -r` of this directory, and zero native deps keeps the service's
 * supply-chain surface at "Node itself".
 *
 * The sidecar records no client IP by default (AVG data minimization) —
 * `receivedAt`, ciphertext `size`, its `sha256`, and the sanitized advisory
 * `filename` are enough for the admin to triage drops offline.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  promises as fs,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { limits } from "./config.js";

export interface DropMeta {
  receivedAt: string; // ISO 8601
  size: number; // ciphertext bytes
  sha256: string; // hex, of the ciphertext
  filename: string; // sanitized advisory name, may be ""
}

export class Storage {
  /**
   * Total bytes currently stored (blobs + sidecars). Maintained incrementally
   * after the initial scan so the P4 check is O(1) per upload.
   */
  private totalBytes = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      this.totalBytes += statSync(join(dir, name)).size;
    }
  }

  /** P4 — would storing `size` more bytes cross the hard cap? */
  hasRoomFor(size: number): boolean {
    return this.totalBytes + size <= limits.storageMaxBytes;
  }

  get storedBytes(): number {
    return this.totalBytes;
  }

  /**
   * Persist one drop atomically. Returns its server-assigned id.
   * The caller has already validated size and content type.
   */
  async store(ciphertext: Buffer, filename: string): Promise<string> {
    const id = randomUUID();
    const meta: DropMeta = {
      receivedAt: new Date().toISOString(),
      size: ciphertext.length,
      sha256: createHash("sha256").update(ciphertext).digest("hex"),
      filename,
    };
    const metaJson = Buffer.from(JSON.stringify(meta, null, 2) + "\n");

    const partPath = join(this.dir, `${id}.part`);
    await fs.writeFile(partPath, ciphertext, { mode: 0o600 });
    await fs.rename(partPath, join(this.dir, `${id}.bin`));
    await fs.writeFile(join(this.dir, `${id}.json`), metaJson, { mode: 0o600 });

    this.totalBytes += ciphertext.length + metaJson.length;

    if (this.totalBytes > limits.storageWarnBytes) {
      console.warn(
        `[storage] ${this.totalBytes} bytes stored > warn threshold ` +
          `${limits.storageWarnBytes} — schedule a pickup (scp) and clear processed drops`,
      );
    }
    return id;
  }

  /**
   * P3 sweep: delete stray `.part` files, warn about drops awaiting pickup
   * longer than `dropMaxAgeWarnDays`, and — only when `DROP_TTL_DAYS` is set —
   * hard-delete drops older than the TTL (bewaartermijn enforcement).
   */
  async sweep(now = Date.now()): Promise<void> {
    const warnMs = limits.dropMaxAgeWarnDays * 24 * 60 * 60 * 1000;
    const ttlMs = limits.dropTtlDays * 24 * 60 * 60 * 1000;
    let stale = 0;

    for (const name of await fs.readdir(this.dir)) {
      const path = join(this.dir, name);
      if (name.endsWith(".part")) {
        const size = (await fs.stat(path)).size;
        await fs.rm(path, { force: true });
        this.totalBytes -= size;
        continue;
      }
      if (!name.endsWith(".bin")) continue;

      const age = now - (await fs.stat(path)).mtimeMs;
      if (ttlMs > 0 && age > ttlMs) {
        const sidecar = path.replace(/\.bin$/, ".json");
        let removed = (await fs.stat(path)).size;
        await fs.rm(path, { force: true });
        try {
          removed += (await fs.stat(sidecar)).size;
          await fs.rm(sidecar, { force: true });
        } catch {
          /* sidecar already gone */
        }
        this.totalBytes -= removed;
        console.log(`[storage] TTL-deleted ${name} (older than ${limits.dropTtlDays}d)`);
      } else if (age > warnMs) {
        stale++;
      }
    }

    if (stale > 0) {
      console.warn(
        `[storage] ${stale} drop(s) older than ${limits.dropMaxAgeWarnDays}d awaiting pickup`,
      );
    }
  }

  /** Start the periodic sweep; unref'd so it never holds the process open. */
  startSweep(): NodeJS.Timeout {
    const t = setInterval(() => {
      this.sweep().catch((err) => console.error("[storage] sweep failed:", err));
    }, limits.sweepIntervalMs);
    t.unref();
    return t;
  }
}
