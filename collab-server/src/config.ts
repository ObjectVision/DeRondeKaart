/**
 * Env-driven limits for the collab server's abuse/overload guards.
 *
 * Every value has a safe, finite default so the guards are active even when
 * nothing is set — there is deliberately no "unlimited" fallback. Operators
 * tune these via systemd `Environment=` lines; see collab-server/README.md.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] ${name}="${raw}" is not a positive number; using default ${fallback}`);
    return fallback;
  }
  return n;
}

const MB = 1024 * 1024;

export const limits = {
  /** P0 — reject persisting a room whose encoded Y.Doc exceeds this. */
  maxDocBytes: num("MAX_DOC_BYTES", 2 * MB),

  /** P1 — per-room annotation count cap. */
  maxAnnotations: num("MAX_ANNOTATIONS", 300),
  /** P1 — annotation title length cap (characters). */
  maxTitleLen: num("MAX_TITLE_LEN", 200),
  /** P1 — annotation description length cap (characters). */
  maxDescLen: num("MAX_DESC_LEN", 2000),
  /** P1 — polygon vertex count cap. */
  maxPolyPoints: num("MAX_POLY_POINTS", 500),
  /** P1 — embedded session-snapshot cap (bytes of JSON). */
  maxSnapshotBytes: num("MAX_SNAPSHOT_BYTES", 128 * 1024),

  /** P2 — per-connection sliding-window flood guard. */
  rateWindowMs: num("RATE_WINDOW_MS", 10_000),
  rateMaxBytesPerWindow: num("RATE_MAX_BYTES_PER_WINDOW", 8 * MB),
  rateMaxMsgsPerWindow: num("RATE_MAX_MSGS_PER_WINDOW", 2000),

  /** P3 — room time-to-live and GC cadence. */
  roomTtlDays: num("ROOM_TTL_DAYS", 90),
  gcIntervalMs: num("GC_INTERVAL_MS", 24 * 60 * 60 * 1000),

  /** P4 — warn when the SQLite file grows past this. */
  dbSizeWarnBytes: num("DB_SIZE_WARN_BYTES", 512 * MB),
} as const;

export type Limits = typeof limits;
