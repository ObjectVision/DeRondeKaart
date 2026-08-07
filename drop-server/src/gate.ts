/**
 * The open/closed gate: whether the drop is currently accepting uploads.
 *
 * State is one file whose PRESENCE means closed and absence means open, so the
 * open state needs no file at all and a fresh install is open by default.
 *
 * Two placement constraints pin its location to `<dataDir>/../closed.json`:
 *   - The systemd unit runs with ProtectSystem=strict and ReadWritePaths set to
 *     the data root, so nothing outside it is writable.
 *   - It must sit BESIDE drops/, never inside: that directory is what the admin
 *     `scp -r`s off the box and what Storage.sweep() walks looking for
 *     .bin/.part files. A state file in there would travel with the drops and
 *     confuse the sweep.
 *
 * Reads are per-request rather than cached at boot: closing must take effect
 * the moment the CLI writes the file, without a restart. One statSync-sized
 * read is nothing next to an upload, and the page fetches the key once a load.
 *
 * Reads FAIL OPEN — a missing, unreadable or malformed file means open. A
 * corrupt state file silently swallowing deliveries that senders believe
 * succeeded is worse than an unintended open drop; the service is built to
 * accept data safely, and every other guard still applies.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./config.js";

export interface ClosedState {
  /** ISO 8601 — when the drop was closed. */
  closedAt: string;
  /** Operator's note, shown to senders on the page. May be "". */
  reason: string;
}

/** Path of the state file: beside drops/, not inside it. */
export function gateFile(dir = dataDir): string {
  return join(dirname(dir), "closed.json");
}

/** Current state: `null` when open (including on any read/parse failure). */
export function readGate(dir = dataDir): ClosedState | null {
  let raw: string;
  try {
    raw = readFileSync(gateFile(dir), "utf8");
  } catch {
    return null; // absent (the common case) or unreadable — open
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const { closedAt, reason } = parsed as Partial<ClosedState>;
    return {
      closedAt: typeof closedAt === "string" ? closedAt : "",
      reason: typeof reason === "string" ? reason : "",
    };
  } catch (err) {
    // Loud, because this is the one case where the operator's intent (closed)
    // is being overridden by fail-open.
    console.error(
      `[gate] ${gateFile(dir)} is unparseable (${String(err)}) — treating the drop as OPEN; ` +
        "re-run `close` to restore it",
    );
    return null;
  }
}

/** Close the drop. Overwrites any existing state (refreshing closedAt). */
export function writeGate(reason: string, dir = dataDir): ClosedState {
  const state: ClosedState = { closedAt: new Date().toISOString(), reason };
  writeFileSync(gateFile(dir), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return state;
}

/** Open the drop. Idempotent: opening an already-open drop is a no-op. */
export function clearGate(dir = dataDir): void {
  rmSync(gateFile(dir), { force: true });
}
