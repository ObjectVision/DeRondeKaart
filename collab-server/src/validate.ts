/**
 * Server-side validation of annotation-document contents (P0 + P1).
 *
 * These are pure functions over plain data so they can be unit-tested without a
 * running Hocuspocus/Yjs stack (see test/validate.test.ts). The server adapter
 * in index.ts pulls the annotations off the live Y.Doc and hands them here.
 *
 * The Yjs CRDT can't be *partially* rejected — by the time a hook runs, the
 * update is already merged into the in-memory doc. So a failure here is a
 * signal to abort the *persist* (don't write bad data to SQLite) and to flag
 * the offending connection for the rate-limiter to close. The keys/limits
 * mirror the client `Annotation` shape in src/types/annotation.ts.
 */

import type { Limits } from "./config.js";

/** Loose mirror of the client Annotation — the wire data is untrusted, so every
 * field is optional/unknown here and narrowed defensively. */
interface RawAnnotation {
  points?: unknown;
  title?: unknown;
  description?: unknown;
  snapshot?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable reason for the first failure (for logs); undefined when ok. */
  reason?: string;
}

const OK: ValidationResult = { ok: true };

/** UTF-8 byte length of a value's JSON encoding (0 when absent/uninspectable). */
function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    // Circular / non-serializable — treat as oversized so it's rejected.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Validate a single annotation's content against the per-field caps.
 * Exported for granular testing; `validateAnnotations` is the entry point.
 */
export function validateAnnotation(a: RawAnnotation, limits: Limits): ValidationResult {
  if (typeof a.title === "string" && a.title.length > limits.maxTitleLen) {
    return { ok: false, reason: `title length ${a.title.length} > ${limits.maxTitleLen}` };
  }
  if (typeof a.description === "string" && a.description.length > limits.maxDescLen) {
    return {
      ok: false,
      reason: `description length ${a.description.length} > ${limits.maxDescLen}`,
    };
  }
  if (Array.isArray(a.points) && a.points.length > limits.maxPolyPoints) {
    return { ok: false, reason: `polygon points ${a.points.length} > ${limits.maxPolyPoints}` };
  }
  const snapBytes = jsonBytes(a.snapshot);
  if (snapBytes > limits.maxSnapshotBytes) {
    return { ok: false, reason: `snapshot ${snapBytes}B > ${limits.maxSnapshotBytes}B` };
  }
  return OK;
}

/**
 * Validate the whole annotations collection: count cap (P1) plus per-annotation
 * content caps. `entries` is the plain-JSON value list from the `annotations`
 * Y.Map (order irrelevant).
 */
export function validateAnnotations(
  entries: RawAnnotation[],
  limits: Limits,
): ValidationResult {
  if (entries.length > limits.maxAnnotations) {
    return { ok: false, reason: `annotation count ${entries.length} > ${limits.maxAnnotations}` };
  }
  for (const a of entries) {
    const r = validateAnnotation(a, limits);
    if (!r.ok) return r;
  }
  return OK;
}

/**
 * P0 — encoded-document size gate. `byteLength` is the size of
 * `Y.encodeStateAsUpdate(doc)`. Kept separate from content validation because
 * it needs no decoding and catches bloat that slips past the semantic caps
 * (e.g. accumulated CRDT history).
 */
export function validateDocSize(byteLength: number, limits: Limits): ValidationResult {
  if (byteLength > limits.maxDocBytes) {
    return { ok: false, reason: `document ${byteLength}B > ${limits.maxDocBytes}B` };
  }
  return OK;
}
