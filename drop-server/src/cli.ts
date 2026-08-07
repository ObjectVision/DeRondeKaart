/**
 * `drop-toggle` — open or close the drop from the shell.
 *
 *   drop-toggle status
 *   drop-toggle close [--reason "buiten kantooruren"]
 *   drop-toggle open
 *
 * Deliberately a CLI and not an HTTP admin route: the administrator already
 * SSHes in to scp the drops off, so this needs no new internet-facing surface
 * and no shared secret to manage. It touches only the state file — never
 * systemctl — so the service keeps running (and keeps answering healthz) while
 * closed, and no sudo is required: the invoking user owns the data dir.
 *
 * Changes take effect on the next request; there is nothing to restart.
 */

import { dataDir } from "./config.js";
import { clearGate, gateFile, readGate, writeGate } from "./gate.js";
import { Storage } from "./storage.js";

const USAGE = `usage: drop-toggle <status|open|close> [--reason "<text>"]

  status   show whether the drop is accepting uploads
  open     start accepting uploads
  close    stop accepting uploads (senders see a "gesloten" page)

Stored drops are never touched by any of these.`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

/** Bytes already on disk — the operator's cue to scp and clear before closing. */
function storedBytes(): number {
  try {
    return new Storage(dataDir).storedBytes;
  } catch {
    return 0; // data dir not created yet: nothing stored
  }
}

function describeStored(): string {
  const bytes = storedBytes();
  if (bytes === 0) return "nothing stored";
  const mb = bytes / (1024 * 1024);
  // Sub-megabyte drops are still drops awaiting pickup — never round them to
  // "nothing", or a closed drop looks empty when it is not.
  return mb >= 0.1 ? `${mb.toFixed(1)} MB stored` : `${bytes} B stored`;
}

const [verb, ...rest] = process.argv.slice(2);

switch (verb) {
  case "status": {
    const state = readGate();
    if (state) {
      console.log(`closed since ${state.closedAt} — ${describeStored()}`);
      if (state.reason) console.log(`reason: ${state.reason}`);
    } else {
      console.log(`open — accepting uploads, ${describeStored()}`);
    }
    break;
  }

  case "close": {
    let reason = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--reason") {
        reason = rest[++i] ?? fail("--reason needs a value");
      } else if (rest[i].startsWith("--reason=")) {
        reason = rest[i].slice("--reason=".length);
      } else {
        fail(`unexpected argument "${rest[i]}"`);
      }
    }
    // The reason is shown verbatim to senders on the public page.
    const state = writeGate(reason.trim());
    console.log(`closed at ${state.closedAt} — ${describeStored()}`);
    if (state.reason) console.log(`reason shown to senders: ${state.reason}`);
    console.log(`state file: ${gateFile()}`);
    break;
  }

  case "open": {
    if (rest.length > 0) fail(`unexpected argument "${rest[0]}"`);
    const was = readGate();
    clearGate();
    console.log(
      was
        ? `open — accepting uploads again (was closed since ${was.closedAt})`
        : "open — was already open, nothing to do",
    );
    break;
  }

  case undefined:
  case "-h":
  case "--help":
    console.log(USAGE);
    break;

  default:
    fail(`unknown command "${verb}"`);
}
