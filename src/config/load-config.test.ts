import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, clearConfigCache } from "@/config/load-config";
import { initVariants, setConfigBase, setVariant } from "@/config/variant";
import { resolveConfigBase } from "@/config/config-source";
import type { VariantsConfig } from "@/config/map-config";

const VARIANTS: VariantsConfig = {
  default: "2025",
  items: [
    { id: "2025", label: "Startanalyse 2025" },
    { id: "2026", label: "Startanalyse 2026" },
  ],
};

/** Record every URL fetched, so a test can prove the cache stopped a refetch. */
const requested: string[] = [];

function stubFetch(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requested.push(url);
      return { ok, status: ok ? 200 : 404, statusText: ok ? "OK" : "Not Found", json: async () => body };
    }),
  );
}

describe("loadConfig", () => {
  beforeEach(() => {
    requested.length = 0;
    clearConfigCache();
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
    setConfigBase("");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches, parses and returns", async () => {
    stubFetch({ n: 1 });
    const value = await loadConfig({
      name: "charts.json",
      parse: (d) => (d as { n: number }).n,
    });
    expect(value).toBe(1);
    expect(requested).toEqual(["/charts.json"]);
  });

  it("parses once and serves the same value afterwards", async () => {
    stubFetch({ n: 1 });
    const parse = vi.fn((d: unknown) => (d as { n: number }).n);
    await loadConfig({ name: "charts.json", parse });
    await loadConfig({ name: "charts.json", parse });
    expect(requested).toEqual(["/charts.json"]);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  // Several components load layers.json on mount, and the variant switch warms
  // two files at once. Without this each caller would fetch and parse its own.
  it("shares one fetch between concurrent callers", async () => {
    stubFetch({ n: 1 });
    const parse = vi.fn((d: unknown) => (d as { n: number }).n);
    const [a, b, c] = await Promise.all([
      loadConfig({ name: "charts.json", parse }),
      loadConfig({ name: "charts.json", parse }),
      loadConfig({ name: "charts.json", parse }),
    ]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(requested).toEqual(["/charts.json"]);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("caches a falsy value rather than refetching it", async () => {
    stubFetch({ n: 0 });
    const parse = vi.fn((d: unknown) => (d as { n: number }).n);
    expect(await loadConfig({ name: "charts.json", parse })).toBe(0);
    expect(await loadConfig({ name: "charts.json", parse })).toBe(0);
    expect(requested).toEqual(["/charts.json"]);
  });

  describe("failure policy", () => {
    it("degrades to the fallback when onError is given", async () => {
      stubFetch(null, false);
      const value = await loadConfig({
        name: "charts.json",
        parse: () => "parsed",
        onError: () => "fallback",
      });
      expect(value).toBe("fallback");
    });

    it("does not call parse on a failed load", async () => {
      stubFetch(null, false);
      const parse = vi.fn(() => "parsed");
      await loadConfig({ name: "charts.json", parse, onError: () => "fallback" });
      expect(parse).not.toHaveBeenCalled();
    });

    // layers.json and navigation.json are structural: an empty catalogue looks
    // exactly like a working app with nothing configured.
    it("rethrows when onError is omitted", async () => {
      stubFetch(null, false);
      await expect(
        loadConfig({ name: "layers.json", parse: () => "parsed" }),
      ).rejects.toThrow(/Failed to load layers\.json/);
    });

    it("surfaces invalid JSON the same way as a missing file", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        })),
      );
      expect(
        await loadConfig({ name: "charts.json", parse: () => "parsed", onError: () => "fallback" }),
      ).toBe("fallback");
    });

    // A rejected promise left in the in-flight map would be replayed to every
    // later caller, so one flaky boot would look like a permanently broken app.
    it("retries after a failure instead of replaying the rejection", async () => {
      stubFetch(null, false);
      await expect(loadConfig({ name: "layers.json", parse: () => "ok" })).rejects.toThrow();

      stubFetch({ n: 1 });
      expect(await loadConfig({ name: "layers.json", parse: () => "ok" })).toBe("ok");
      expect(requested).toEqual(["/layers.json", "/layers.json"]);
    });
  });

  describe("config variants", () => {
    beforeEach(() => initVariants(VARIANTS));

    it("fetches a per-variant file from its variant directory", async () => {
      stubFetch({ n: 1 });
      await loadConfig({ name: "layers.json", parse: (d) => d });
      expect(requested).toEqual(["/2025/layers.json"]);
    });

    it("leaves a shared file at the site root", async () => {
      stubFetch({ n: 1 });
      await loadConfig({ name: "charts.json", parse: (d) => d });
      expect(requested).toEqual(["/charts.json"]);
    });

    // The whole point of keying by variant: ids are reused between years, so a
    // single cache entry would serve 2025's layers under a 2026 label — a
    // plausible map showing the wrong year, with no error anywhere.
    //
    // The stub answers from the URL, the way the server does. Re-stubbing
    // between switches would hide a variant-blind cache key, because the second
    // load would read fresh data whether or not the key distinguished them.
    it("caches a per-variant file separately per variant", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          requested.push(url);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ year: url.startsWith("/2026/") ? "2026" : "2025" }),
          };
        }),
      );

      const load = () => loadConfig({ name: "layers.json", parse: (d) => d });

      expect(await load()).toEqual({ year: "2025" });

      setVariant("2026");
      expect(await load()).toEqual({ year: "2026" });

      // Back to 2025: its own entry is still there, so no refetch and — the part
      // that matters — not 2026's parsed value.
      setVariant("2025");
      expect(await load()).toEqual({ year: "2025" });
      expect(requested).toEqual(["/2025/layers.json", "/2026/layers.json"]);
    });

    it("keeps one cache entry for a shared file across variants", async () => {
      stubFetch({ n: 1 });
      await loadConfig({ name: "charts.json", parse: (d) => d });
      setVariant("2026");
      await loadConfig({ name: "charts.json", parse: (d) => d });
      expect(requested).toEqual(["/charts.json"]);
    });
  });

  describe("clearConfigCache", () => {
    it("drops one file, leaving the others cached", async () => {
      stubFetch({ n: 1 });
      await loadConfig({ name: "charts.json", parse: (d) => d });
      await loadConfig({ name: "filter.json", parse: (d) => d });
      expect(requested).toEqual(["/charts.json", "/filter.json"]);

      clearConfigCache("charts.json");
      await loadConfig({ name: "charts.json", parse: (d) => d });
      await loadConfig({ name: "filter.json", parse: (d) => d });
      expect(requested).toEqual(["/charts.json", "/filter.json", "/charts.json"]);
    });

    it("drops a file across every variant", async () => {
      initVariants(VARIANTS);
      stubFetch({ n: 1 });
      await loadConfig({ name: "layers.json", parse: (d) => d });
      setVariant("2026");
      await loadConfig({ name: "layers.json", parse: (d) => d });

      clearConfigCache("layers.json");
      await loadConfig({ name: "layers.json", parse: (d) => d });
      expect(requested).toEqual([
        "/2025/layers.json",
        "/2026/layers.json",
        "/2026/layers.json",
      ]);
    });
  });
});

/**
 * A remote config base (`?config=`) changes where every file is fetched from.
 * The cache key has to follow, or two sources in one session collide on the
 * file name and the second caller is served the first source's content — with
 * nothing on screen to say so.
 */
describe("loadConfig with a remote config base", () => {
  const A = "https://raw.githubusercontent.com/Owner/a";
  const B = "https://raw.githubusercontent.com/Owner/b";

  // Its own hooks: this block is a sibling of the one above, so it does not
  // inherit those. The base is module state and leaks into later tests without
  // the reset.
  beforeEach(() => {
    requested.length = 0;
    clearConfigCache();
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
    setConfigBase("");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setConfigBase("");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches from the base instead of this origin", async () => {
    setConfigBase(A);
    stubFetch({ n: 1 });
    await loadConfig({ name: "charts.json", parse: (d) => d });
    expect(requested).toEqual([`${A}/charts.json`]);
  });

  it("keeps the variant folder in the remote path", async () => {
    setConfigBase(A);
    initVariants(VARIANTS);
    setVariant("2026");
    stubFetch({ n: 1 });
    await loadConfig({ name: "layers.json", parse: (d) => d });
    expect(requested).toEqual([`${A}/2026/layers.json`]);
  });

  it("does not share a cache entry between two bases", async () => {
    setConfigBase(A);
    stubFetch({ which: "a" });
    const first = await loadConfig({ name: "charts.json", parse: (d) => d });

    setConfigBase(B);
    stubFetch({ which: "b" });
    const second = await loadConfig({ name: "charts.json", parse: (d) => d });

    expect(first).toEqual({ which: "a" });
    expect(second).toEqual({ which: "b" });
    expect(requested).toEqual([`${A}/charts.json`, `${B}/charts.json`]);
  });

  /**
   * main.tsx's two-phase boot, which is the security model in sequence form:
   * the FIRST map.json must come from this origin, because it carries the
   * allowlist that decides whether the remote one may be read at all. Reading
   * `configSources` from the remote config would let it authorise itself, and
   * nothing on screen would differ.
   */
  it("reads the allowlist from this origin, then switches to the remote", async () => {
    const bodies: Record<string, unknown> = {
      "/map.json": { configSources: [A], zoom: 7 },
      [`${A}/map.json`]: { zoom: 12 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        return { ok: true, status: 200, statusText: "OK", json: async () => bodies[url] };
      }),
    );

    // Phase 1 — this origin, whatever the URL asked for.
    const local = await loadConfig({
      name: "map.json",
      parse: (d) => d as { configSources: string[] },
    });
    const base = resolveConfigBase(A, local.configSources);
    expect(base).toBe(A);

    // Phase 2 — the remote one, under its own cache entry.
    setConfigBase(base!);
    const remote = await loadConfig({ name: "map.json", parse: (d) => d as { zoom: number } });

    expect(remote.zoom).toBe(12);
    expect(requested).toEqual(["/map.json", `${A}/map.json`]);
  });

  it("stays on this origin when the allowlist does not cover the request", async () => {
    stubFetch({ configSources: ["https://raw.githubusercontent.com/Other/x"] });
    const local = await loadConfig({
      name: "map.json",
      parse: (d) => d as { configSources: string[] },
    });
    expect(resolveConfigBase(A, local.configSources)).toBeNull();
  });

  // The path every existing deployment takes; it must be untouched.
  it("falls back to this origin when no base is set", async () => {
    stubFetch({ n: 1 });
    await loadConfig({ name: "charts.json", parse: (d) => d });
    expect(requested).toEqual(["/charts.json"]);
  });
});
