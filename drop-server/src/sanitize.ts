/**
 * Client-declared filename hygiene (P1).
 *
 * The name arrives percent-encoded in the X-Drop-Filename header and is
 * ADVISORY metadata only — storage names are always server-generated UUIDs, so
 * nothing here is load-bearing for path safety. Sanitizing anyway keeps the
 * sidecar JSON safe to display in a terminal and safe to reuse as an output
 * filename by tools/drop_decrypt.py.
 */

import { limits } from "./config.js";

export function sanitizeFilename(raw: string | undefined): string {
  if (!raw) return "";
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return ""; // malformed percent-encoding: drop the advisory name entirely
  }
  return (
    name
      // Path separators and the characters Windows forbids in names.
      .replace(/[/\\:*?"<>|]/g, "_")
      // Control chars (incl. newlines that would corrupt log lines).
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u001f\u007f]/g, "")
      // Leading dots would make hidden files if reused verbatim.
      .replace(/^\.+/, "")
      .trim()
      .slice(0, limits.maxFilenameLen)
  );
}
