import { afterEach, describe, expect, it, vi } from "vitest";

import { loadMapConfig } from "@/config/map-config";
import { geocode, geocodeExtent } from "@/tools/geocode";

/**
 * Provider routing and failure handling.
 *
 * Routing is asserted on the URL HOST rather than on parsed output, and that is
 * deliberate: the provider is module-global state set as a side effect of
 * `loadMapConfig`, so a test that forgot to load a config would still get a
 * working geocoder — the default one — and quietly prove nothing about the
 * backend it meant to exercise.
 */

/** Point `loadMapConfig` at a map.json body. */
function stubMapJson(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, statusText: "OK", json: async () => body })),
  );
}

/** Load a config, then geocode, and return the host that was called. */
async function hostFor(mapControls: Record<string, unknown>): Promise<string> {
  stubMapJson({ mapControls: { search: true, ...mapControls } });
  await loadMapConfig();
  vi.unstubAllGlobals();

  const spy = vi.fn<(url: string) => Promise<unknown>>(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ response: { docs: [] } }),
  }));
  vi.stubGlobal("fetch", spy);

  await geocode("Venlo");
  return new URL(String(spy.mock.calls[0]?.[0])).host;
}

afterEach(() => vi.unstubAllGlobals());

describe("geocode provider routing", () => {
  it("uses PDOK when the config selects it", async () => {
    await expect(hostFor({ searchProvider: "pdok" })).resolves.toBe("api.pdok.nl");
  });

  it("uses Nominatim when the config selects it", async () => {
    await expect(hostFor({ searchProvider: "nominatim" })).resolves.toBe(
      "nominatim.openstreetmap.org",
    );
  });

  /**
   * The default-preservation guarantee: a project that says nothing about a
   * provider keeps the geocoder it has always had.
   */
  it("falls back to Nominatim when the key is absent", async () => {
    await expect(hostFor({})).resolves.toBe("nominatim.openstreetmap.org");
  });

  it("falls back to Nominatim on an unknown provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(hostFor({ searchProvider: "google" })).resolves.toBe(
      "nominatim.openstreetmap.org",
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("searchProvider"));
    warn.mockRestore();
  });
});

describe("geocode failure handling", () => {
  it("does not call out for an empty query", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(geocode("   ")).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports an empty list rather than throwing when the geocoder errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(geocode("Venlo")).resolves.toEqual([]);

    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  /**
   * An abort is this app cancelling its own request because the user kept
   * typing. Logging it would put a console line under every keystroke.
   */
  it("stays silent when a request is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(geocode("Venlo")).resolves.toEqual([]);

    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("geocodeExtent", () => {
  const result = {
    id: "gem-1",
    label: "Gemeente Venlo",
    kind: "gemeente",
    center: [6, 51] as [number, number],
  };

  // Nominatim ships the box with the search result, so there is nothing to fetch.
  it("uses an extent the result already carries, without a request", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(
      geocodeExtent({ ...result, bbox: [6, 51, 7, 52] }),
    ).resolves.toEqual([6, 51, 7, 52]);
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A failed lookup costs framing, not the search: the caller still flies to
   * the centroid, so this warns rather than propagating.
   */
  it("returns undefined rather than throwing when the lookup fails", async () => {
    stubMapJson({ mapControls: { searchProvider: "pdok" } });
    await loadMapConfig();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(geocodeExtent(result)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Nominatim declares no resolveExtent at all: nothing more to fetch, ever.
  it("returns undefined for a provider with no lookup step", async () => {
    stubMapJson({ mapControls: { searchProvider: "nominatim" } });
    await loadMapConfig();
    vi.unstubAllGlobals();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(geocodeExtent(result)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
