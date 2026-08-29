import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleFetch, whenIdle, type IdleSource } from "@/lib/idle-fetch";

/** A map that is busy until `settle()` is called. */
function busyMap() {
  let cb: (() => void) | null = null;
  let quiet = false;
  const map: IdleSource = {
    loaded: () => quiet,
    isMoving: () => false,
    once: (_e, fn) => {
      cb = fn;
      return undefined;
    },
  };
  return {
    map,
    settle() {
      quiet = true;
      cb?.();
      cb = null;
    },
    get waiting() {
      return cb !== null;
    },
  };
}

const idleMap: IdleSource = { loaded: () => true, isMoving: () => false, once: () => undefined };

/** A host serving `body` with Range support. */
function rangeHost(body: Uint8Array, opts: { ranges?: boolean } = {}) {
  const ranges = opts.ranges ?? true;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return {
        ok: true,
        headers: { get: (h: string) => (h === "content-length" ? String(body.length) : null) },
      };
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    if (range && ranges) {
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range)!;
      const slice = body.slice(Number(s), Number(e) + 1);
      return { ok: true, status: 206, arrayBuffer: async () => slice.buffer };
    }
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
  });
}

describe("whenIdle", () => {
  it("resolves at once when the map is already quiet", async () => {
    await expect(whenIdle(idleMap)).resolves.toBeUndefined();
  });

  it("resolves at once when there is no map to wait for", async () => {
    await expect(whenIdle(null)).resolves.toBeUndefined();
  });

  // The gate is the whole mechanism: while the map is busy, nothing proceeds.
  it("waits for idle while the map is busy", async () => {
    const m = busyMap();
    let done = false;
    void whenIdle(m.map).then(() => (done = true));

    await Promise.resolve();
    expect(done).toBe(false);

    m.settle();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

describe("idleFetch", () => {
  beforeEach(() => vi.stubGlobal("caches", undefined));
  afterEach(() => vi.unstubAllGlobals());

  it("reassembles ranged chunks into the original bytes", async () => {
    // Bigger than one 512 KB chunk, so the loop actually runs more than once.
    const body = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    vi.stubGlobal("fetch", rangeHost(body));

    const out = new Uint8Array(await idleFetch("/m.bin", { map: idleMap, cacheName: "t" }));

    expect(out.byteLength).toBe(body.byteLength);
    expect(out).toEqual(body);
  });

  /**
   * A host that ignores Range returns 200 with the whole body. Continuing the
   * chunk loop would re-download everything per chunk — so this must be caught
   * and reported, not silently looped.
   */
  it("detects a host that ignores Range instead of re-downloading per chunk", async () => {
    const body = new Uint8Array(1024 * 1024).fill(7);
    const fetchSpy = rangeHost(body, { ranges: false });
    vi.stubGlobal("fetch", fetchSpy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = new Uint8Array(await idleFetch("/m.bin", { map: idleMap, cacheName: "t" }));

    expect(out.byteLength).toBe(body.byteLength);
    expect(warn).toHaveBeenCalled();
    // HEAD + exactly one ranged attempt: it stopped rather than looping.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does not start a chunk while the map is busy", async () => {
    const body = new Uint8Array(1024 * 1024).fill(3);
    const fetchSpy = rangeHost(body);
    vi.stubGlobal("fetch", fetchSpy);
    const m = busyMap();

    let settled = false;
    void idleFetch("/m.bin", { map: m.map, cacheName: "t" }).then(() => (settled = true));

    // Drain the microtask queue thoroughly: without the gate the whole chunk
    // loop would run to completion here, since every stubbed response resolves
    // immediately. Fewer turns than this and the assertion passes for the wrong
    // reason — it did with 2.
    for (let i = 0; i < 50; i++) await Promise.resolve();

    const ranged = fetchSpy.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method !== "HEAD",
    ).length;
    expect(ranged).toBe(0);
    expect(settled).toBe(false);

    // And it completes once the map goes quiet, so the gate delays rather than
    // deadlocks.
    m.settle();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("reports determinate progress", async () => {
    const body = new Uint8Array(1024 * 1024).fill(1);
    vi.stubGlobal("fetch", rangeHost(body));
    const seen: Array<[number, number]> = [];

    await idleFetch("/m.bin", {
      map: idleMap,
      cacheName: "t",
      onProgress: (l, t) => seen.push([l, t]),
    });

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual([body.byteLength, body.byteLength]);
  });

  it("falls back to one request when the host gives no length", async () => {
    const body = new Uint8Array(64).fill(9);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method === "HEAD"
          ? { ok: true, headers: { get: () => null } }
          : { ok: true, status: 200, arrayBuffer: async () => body.buffer },
      ),
    );

    const out = new Uint8Array(await idleFetch("/m.bin", { map: idleMap, cacheName: "t" }));

    expect(out).toEqual(body);
  });
});
