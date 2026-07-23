/**
 * Per-connection flood guard (P2).
 *
 * P0/P1 stop bad *data* from being persisted, but a client can still spin the
 * event loop by firing high-frequency or large updates (each store is a
 * synchronous better-sqlite3 write). This tracks bytes + message counts per
 * connection over a sliding window; when either ceiling is crossed the caller
 * closes the socket.
 *
 * In-process only (a Map keyed by socketId) — fine for the single-instance
 * server. State is dropped on disconnect via `forget()`.
 */

import { limits } from "./config.js";

interface Window {
  /** Epoch ms when the current window started. */
  start: number;
  bytes: number;
  msgs: number;
}

export interface RateDecision {
  allowed: boolean;
  reason?: string;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    private readonly windowMs = limits.rateWindowMs,
    private readonly maxBytes = limits.rateMaxBytesPerWindow,
    private readonly maxMsgs = limits.rateMaxMsgsPerWindow,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record an inbound message of `byteLength` on `key` (socketId) and decide
   * whether the connection is still within budget. A crossed ceiling stays
   * blocked for the remainder of the window.
   */
  record(key: string, byteLength: number): RateDecision {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, bytes: 0, msgs: 0 };
      this.windows.set(key, w);
    }
    w.bytes += byteLength;
    w.msgs += 1;

    if (w.bytes > this.maxBytes) {
      return { allowed: false, reason: `${w.bytes}B in ${this.windowMs}ms > ${this.maxBytes}B` };
    }
    if (w.msgs > this.maxMsgs) {
      return { allowed: false, reason: `${w.msgs} msgs in ${this.windowMs}ms > ${this.maxMsgs}` };
    }
    return { allowed: true };
  }

  /** Drop tracking for a disconnected connection. */
  forget(key: string): void {
    this.windows.delete(key);
  }
}
