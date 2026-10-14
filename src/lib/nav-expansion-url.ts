/**
 * The `nav` share-link parameter: the navigation tree's expand/collapse state,
 * as a diff against what `navigation.json` configures.
 *
 * Only the diff travels. A link made from an untouched tree carries no `nav` at
 * all, and a branch the user toggled and then toggled back contributes nothing —
 * so ordinary links stay short and the parameter means "what I changed", not
 * "what the tree looks like".
 *
 * Two groups, because the diff runs both ways: a branch the config opens by
 * default and the user CLOSED is as much part of their state as one they opened.
 *
 *     nav=<open tokens>*<closed tokens>
 *     nav=QAk2aB.28_LcD*ekYLgH
 *
 * Branches are identified by a hash of their label path rather than by position.
 * That is the whole design decision here, and it is not theoretical: the shipped
 * navigation.json files get reordered and renested regularly (real commits:
 * "Grouped Referentie 2023 and Referentie 2030 in new level Referentiebeelden",
 * "Move <20% kostenverschil", "Removed S4 from 2026 variant"). An ordinal or
 * bitmask encoding is far more compact, but after any such edit it would open
 * the WRONG branches — silently, with no error, which is the worst way for a
 * share link to fail. Hashing the path costs ~500 characters in the worst case
 * (against the 1800 the share dialog warns at) and survives every reordering.
 *
 * What it does NOT survive is a label RENAME: the token then matches no branch
 * and is skipped, leaving that branch at its configured default. Accepted — it
 * is the same way the sessionStorage blob already degrades, and the alternative
 * (rejecting the whole param) would throw away a dozen good branches because one
 * label gained a comma.
 */

/** Hash parameter holding the whole diff. Named in one place, read in two. */
export const NAV_PARAM = "nav";

/**
 * Separates the open group from the closed group, and tokens within a group.
 *
 * `*` and `.` specifically: `URLSearchParams.toString()` leaves exactly
 * `* - _ .` and alphanumerics unescaped, and of those `-` and `_` are part of
 * the base64url alphabet and so cannot be delimiters. The obvious `~` is
 * percent-encoded to `%7E`, which still round-trips but inflates every link and
 * makes a hand-read URL look broken.
 */
const GROUP_SEP = "*";

/** Separates tokens within a group. See the note on GROUP_SEP. */
const TOKEN_SEP = ".";

/** 4 bytes of hash -> 6 base64url characters, with no padding. */
const TOKEN_LENGTH = 6;

/** The base64url alphabet, for validating tokens out of someone else's URL. */
const TOKEN_RE = /^[A-Za-z0-9_-]{6}$/;

/**
 * FNV-1a over the UTF-8 bytes of the path, as 4 bytes of base64url.
 *
 * Deliberately not `crypto.subtle.digest`: that is async, and making it the
 * identity function would turn every `isOpen`-adjacent call site and the whole
 * share-URL build into promises for no benefit. Nothing security-sensitive rides
 * on this — the only requirement is that two different branch paths in one
 * config are unlikely to collide, and across all 121 branch paths in every
 * shipped config there are zero collisions.
 *
 * 4 bytes rather than 3: at 121 paths the birthday probability is ~0.04% for 3
 * bytes versus negligible for 4, and a collision would open the wrong branch —
 * exactly the failure mode positional encoding was rejected for. The extra two
 * characters per token are cheap insurance.
 */
export function branchToken(pathKey: string): string {
  const bytes = new TextEncoder().encode(pathKey);

  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // `Math.imul`, not `*`: the product of two 32-bit values exceeds 2^53 and a
    // plain multiply would silently lose the low bits. imul is the 32-bit
    // multiply this needs, and `>>> 0` makes the signed result unsigned again.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  const out = new Uint8Array(4);
  out[0] = (hash >>> 24) & 0xff;
  out[1] = (hash >>> 16) & 0xff;
  out[2] = (hash >>> 8) & 0xff;
  out[3] = hash & 0xff;

  let binary = "";
  for (const byte of out) binary += String.fromCharCode(byte);
  // base64url: `+` and `/` are meaningful in a URL and `=` would be
  // percent-encoded by URLSearchParams. 4 bytes encode to 6 chars + padding.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encode a path-keyed diff for one `nav` param.
 *
 * Returns "" when the diff is empty, which the caller treats as "omit the
 * parameter" — a link from an untouched tree should not carry `nav=*`.
 */
export function encodeNavExpansionParam(diff: Record<string, boolean>): string {
  const open: string[] = [];
  const closed: string[] = [];

  for (const [pathKey, isOpen] of Object.entries(diff)) {
    (isOpen ? open : closed).push(branchToken(pathKey));
  }

  if (open.length === 0 && closed.length === 0) return "";
  return `${open.join(TOKEN_SEP)}${GROUP_SEP}${closed.join(TOKEN_SEP)}`;
}

/** Token sets from a `nav` param. Resolving them to branches needs the tree. */
export interface NavExpansionParam {
  open: Set<string>;
  closed: Set<string>;
}

/**
 * Read a `nav` param back.
 *
 * Returns `null` for MALFORMED input — wrong group count, or a token that is not
 * 6 base64url characters — the way a bad `combi` or `basemap` is rejected and
 * skipped by the caller.
 *
 * Note the asymmetry with `parseFilterLayerParam`, which rejects the whole param
 * when one ELEMENT fails to validate. Here a well-formed token that matches no
 * branch is not a failure at all: it is what a renamed label looks like, and it
 * is dropped later by the applier rather than here. Structure is validated
 * strictly; resolvability is tolerated per token.
 */
export function parseNavExpansionParam(raw: string): NavExpansionParam | null {
  const groups = raw.split(GROUP_SEP);
  if (groups.length !== 2) return null;

  const sets: Set<string>[] = [];
  for (const group of groups) {
    const tokens = new Set<string>();
    // "" splits to [""], which is an empty group, not a bad one: `nav=*abc123`
    // (nothing opened, one branch closed) is legitimate.
    if (group !== "") {
      for (const token of group.split(TOKEN_SEP)) {
        if (!TOKEN_RE.test(token)) return null;
        tokens.add(token);
      }
    }
    sets.push(tokens);
  }

  const [open, closed] = sets;
  // A token in both groups is contradictory — it cannot be both opened and
  // closed — so the param was built wrong or tampered with.
  for (const token of open) if (closed.has(token)) return null;

  return { open, closed };
}

/** Exported for the test that pins the wire format. */
export const NAV_TOKEN_LENGTH = TOKEN_LENGTH;
