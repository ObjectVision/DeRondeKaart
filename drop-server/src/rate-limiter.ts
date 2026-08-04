/**
 * Per-IP drop-count flood guard (P2).
 *
 * nginx `limit_req` is the outer wall in production; this in-process window
 * keeps the service safe when fronted differently (dev, tests, a misconfigured
 * proxy). Ported from collab-server/src/rate-limiter.ts, simplified to a
 * count-only budget: upload *size* is already bounded by P0, so counting
 * requests per window is enough.
 *
 * In-process only (a Map keyed by client IP) — fine for the single-instance
 * server. Stale windows are pruned lazily on each record().
 */

import { limits } from "./config.js";

interface Window {
  /** Epoch ms when the current window started. */
  start: number;
  drops: number;
}

export interface RateDecision {
  allowed: boolean;
  reason?: string;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    private readonly windowMs = limits.rateWindowMs,
    private readonly maxDrops = limits.rateMaxDropsPerWindow,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one upload attempt from `key` (client IP) and decide whether it is
   * still within budget. A crossed ceiling stays blocked for the remainder of
   * the window.
   */
  record(key: string): RateDecision {
    const t = this.now();

    // Lazy prune: unlike the collab server there is no disconnect event to
    // hook forget() to, so expired windows are dropped here to bound the map.
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) {
        if (t - w.start >= this.windowMs) this.windows.delete(k);
      }
    }

    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, drops: 0 };
      this.windows.set(key, w);
    }
    w.drops += 1;

    if (w.drops > this.maxDrops) {
      return {
        allowed: false,
        reason: `${w.drops} drops in ${this.windowMs}ms > ${this.maxDrops}`,
      };
    }
    return { allowed: true };
  }
}
