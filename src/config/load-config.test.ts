import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, clearConfigCache } from "@/config/load-config";
import { initVariants, setVariant } from "@/config/variant";
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
