/**
 * Downloading large model weights without slowing the map down.
 *
 * The map is the product: its tiles, parquet layers and config must never queue
 * behind a model download. `fetch(url, { priority: "low" })` is only a hint —
 * browsers may ignore it, support outside Chromium is partial, and it does
 * nothing about connection contention. So the real mechanism here is a gate: a
 * download that has not started cannot compete with anything.
 *
 * The gate is MapLibre's own `idle` event, which fires when no tiles are
 * loading and nothing is left to render. Between chunks the gate is re-checked,
 * which is what makes this YIELD rather than merely start late: a user who pans
 * mid-download takes the connection back within one chunk.
 */

/** Just enough of a MapLibre map for the gate; keeps this testable. */
export interface IdleSource {
  loaded: () => boolean;
  isMoving?: () => boolean;
  once: (event: "idle", cb: () => void) => unknown;
}

/** Resolves when the map is quiet, or at once if it already is. */
export function whenIdle(map: IdleSource | null): Promise<void> {
  if (!map) return Promise.resolve();
  if (map.loaded() && !(map.isMoving?.() ?? false)) return Promise.resolve();
  return new Promise((resolve) => map.once("idle", () => resolve()));
}

/** 512 KB: small enough to yield promptly, large enough not to thrash. */
const CHUNK_BYTES = 512 * 1024;

export interface IdleFetchOptions {
  /** Consulted before every chunk; null disables gating. */
  map: IdleSource | null;
  /** Cache Storage bucket. Include the model revision so a new one re-fetches. */
  cacheName: string;
  signal?: AbortSignal;
  /** Bytes so far / total, for a determinate progress bar. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Fetch a large asset in idle-gated chunks, caching the result.
 *
 * A cache hit skips the network entirely, so the 13.7 MB is paid once per
 * browser rather than once per visit.
 */
export async function idleFetch(
  url: string,
  options: IdleFetchOptions,
): Promise<ArrayBuffer> {
  const cached = await readCache(options.cacheName, url);
  if (cached) {
    options.onProgress?.(cached.byteLength, cached.byteLength);
    return cached;
  }

  const total = await contentLength(url, options.signal);

  // No length, or a host that will not do ranges: one plain request. Still
  // gated, so it at least waits for a quiet map before starting.
  if (total === null) {
    await whenIdle(options.map);
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const buf = await res.arrayBuffer();
    await writeCache(options.cacheName, url, buf);
    options.onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }

  const parts: Uint8Array[] = [];
  let loaded = 0;

  for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
    // The gate, re-checked per chunk. This is the whole mechanism.
    await whenIdle(options.map);

    const end = Math.min(offset + CHUNK_BYTES - 1, total - 1);
    const res = await fetch(url, {
      headers: { Range: `bytes=${offset}-${end}` },
      // A hint on top of the gate, not instead of it.
      priority: "low",
      signal: options.signal,
    } as RequestInit);

    if (res.status !== 206) {
      // The host ignored Range and sent the whole body. Continuing the loop
      // would re-download everything per chunk, so take this body and stop —
      // loudly, because the caller's chunking is silently not happening.
      console.warn(
        `${url}: expected 206 for a ranged request, got ${res.status}; ` +
          "falling back to a single unchunked download",
      );
      const buf = await res.arrayBuffer();
      await writeCache(options.cacheName, url, buf);
      options.onProgress?.(buf.byteLength, buf.byteLength);
      return buf;
    }

    const chunk = new Uint8Array(await res.arrayBuffer());
    parts.push(chunk);
    loaded += chunk.byteLength;
    options.onProgress?.(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }

  await writeCache(options.cacheName, url, out.buffer);
  return out.buffer;
}

/** Total size, or null when the host will not say. */
async function contentLength(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal });
    if (!res.ok) return null;
    const raw = res.headers.get("content-length");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Cache Storage rather than IndexedDB: it stores Response objects directly,
 * which is the natural fit for something fetched over HTTP. Every access is
 * guarded — the API is absent in some embedded contexts and throws when a
 * browser is set to block site data, and a cache miss must never be fatal.
 */
async function readCache(cacheName: string, url: string): Promise<ArrayBuffer | null> {
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(cacheName);
    const hit = await cache.match(url);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function writeCache(cacheName: string, url: string, body: ArrayBuffer): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(cacheName);
    await cache.put(url, new Response(body));
  } catch {
    // Storage unavailable or full: the download still works this session, it
    // just will not survive a reload.
  }
}
