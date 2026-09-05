import { afterEach, describe, expect, it, vi } from "vitest";

import { pdokProvider } from "@/tools/geocode/pdok";

/**
 * The PDOK Locatieserver provider.
 *
 * Assertions are on the REQUEST as much as the parsed output. Provider
 * selection is module-global (set as a side effect of `loadMapConfig`), so a
 * test that only checked parsed results could pass while silently talking to
 * the wrong backend; checking the URL is what pins the endpoint down.
 */

/** A Locatieserver response body wrapping `docs`. */
function body(docs: unknown[]) {
  return { response: { numFound: docs.length, docs } };
}

/** Stub fetch with a response, and hand back the spy. */
function stubFetch(payload: unknown, ok = true) {
  const spy = vi.fn<(url: string) => Promise<unknown>>(async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The URL of the first fetch call. */
function calledUrl(spy: { mock: { calls: unknown[][] } }): string {
  return String(spy.mock.calls[0]?.[0] ?? "");
}

const VENLO = {
  id: "gem-a1b3b381",
  weergavenaam: "Gemeente Venlo",
  type: "gemeente",
  centroide_ll: "POINT(6.15911182 51.39095482)",
};

afterEach(() => vi.unstubAllGlobals());

describe("pdokProvider.search", () => {
  /**
   * The endpoint choice is load-bearing, not cosmetic. `free` matches whole
   * terms and answers the partial "Venl" with nothing at all, which would leave
   * the suggestion list empty for every word the user is halfway through
   * typing. `suggest` is the type-ahead endpoint.
   */
  it("queries the suggest endpoint, not free", async () => {
    const spy = stubFetch(body([VENLO]));

    await pdokProvider.search("Venl", 5);

    expect(calledUrl(spy)).toContain("/suggest?");
    expect(calledUrl(spy)).not.toContain("/free?");
  });

  it("passes the query and the row limit", async () => {
    const spy = stubFetch(body([]));

    await pdokProvider.search("Venlo", 5);

    expect(calledUrl(spy)).toContain("q=Venlo");
    expect(calledUrl(spy)).toContain("rows=5");
  });

  /**
   * `fl` is a whitelist: a field missing from it is absent from the response
   * with no error, so the parser would silently see `undefined`.
   */
  it("requests every field the parser reads", async () => {
    const spy = stubFetch(body([]));

    await pdokProvider.search("Venlo", 5);

    const url = decodeURIComponent(calledUrl(spy));
    for (const field of ["id", "weergavenaam", "type", "centroide_ll"]) {
      expect(url).toContain(field);
    }
  });

  it("maps a document to a result, reading lon before lat", async () => {
    stubFetch(body([VENLO]));

    const [first] = await pdokProvider.search("Venlo", 5);

    expect(first).toEqual({
      id: "gem-a1b3b381",
      label: "Gemeente Venlo",
      kind: "gemeente",
      center: [6.15911182, 51.39095482],
    });
  });

  /**
   * PDOK's own `typesortering` is what puts Bergen in Limburg above Bergen in
   * Noord-Holland. Re-sorting locally would be a second ranking policy to keep
   * in step with theirs, so the order must survive untouched.
   */
  it("preserves the server's ranking", async () => {
    stubFetch(
      body([
        { ...VENLO, id: "gem-l", weergavenaam: "Gemeente Bergen (L)" },
        { ...VENLO, id: "gem-nh", weergavenaam: "Gemeente Bergen (NH)" },
        { ...VENLO, id: "gem-oz", weergavenaam: "Gemeente Bergen op Zoom" },
      ]),
    );

    const results = await pdokProvider.search("Bergen", 5);

    expect(results.map((r) => r.label)).toEqual([
      "Gemeente Bergen (L)",
      "Gemeente Bergen (NH)",
      "Gemeente Bergen op Zoom",
    ]);
  });

  it("carries no bbox — the extent is a separate lookup", async () => {
    stubFetch(body([VENLO]));

    const [first] = await pdokProvider.search("Venlo", 5);

    expect(first.bbox).toBeUndefined();
  });

  // A result the map cannot fly to is not a candidate, but its neighbours are
  // still perfectly good.
  it("drops a document with an unusable centroid and keeps the rest", async () => {
    stubFetch(
      body([
        { ...VENLO, id: "broken", centroide_ll: "POINT(nonsense)" },
        { ...VENLO, id: "good" },
      ]),
    );

    const results = await pdokProvider.search("Venlo", 5);

    expect(results.map((r) => r.id)).toEqual(["good"]);
  });

  /**
   * The coordinate is what makes a hit usable; the label is presentation, and
   * the headless tool path never reads it. Discarding a flyable result over a
   * missing name would turn a working search into "niets gevonden".
   */
  it("keeps a result with coordinates but no display name", async () => {
    stubFetch(body([{ ...VENLO, weergavenaam: undefined }]));

    const [first] = await pdokProvider.search("Venlo", 5);

    expect(first.center).toEqual([6.15911182, 51.39095482]);
    expect(first.label).toBe("Venlo");
  });

  it("falls back to a synthetic id when the document has none", async () => {
    stubFetch(body([{ ...VENLO, id: undefined }]));

    const [first] = await pdokProvider.search("Venlo", 5);

    expect(first.id).toBe("gemeente:Gemeente Venlo");
  });

  it("returns nothing for an empty result set", async () => {
    stubFetch(body([]));

    await expect(pdokProvider.search("Atlantis", 5)).resolves.toEqual([]);
  });

  it("throws on an HTTP error, for geocode() to turn into an empty list", async () => {
    stubFetch(body([]), false);

    await expect(pdokProvider.search("Venlo", 5)).rejects.toThrow(/500/);
  });

  /**
   * PDOK is Netherlands-only, so `searchCountries` has nothing to select and is
   * documented as ignored. Sending it would be a parameter the API does not
   * know, on every request.
   */
  it("sends no country parameter, even when one is configured", async () => {
    vi.doMock("@/config/map-config", () => ({ searchCountries: () => ["de"] }));
    const spy = stubFetch(body([]));

    await pdokProvider.search("Venlo", 5);

    const url = calledUrl(spy).toLowerCase();
    expect(url).not.toContain("country");
    expect(url).not.toContain("countrycodes");
    vi.doUnmock("@/config/map-config");
  });
});

describe("pdokProvider.resolveExtent", () => {
  const result = { id: "gem-a1b3b381", label: "Gemeente Venlo", kind: "gemeente", center: [6, 51] as [number, number] };

  it("looks the candidate up by id and returns its envelope", async () => {
    const spy = stubFetch(
      body([{ geometrie_ll: "MULTIPOLYGON(((6 51,7 51,7 52,6 52,6 51)))" }]),
    );

    const bbox = await pdokProvider.resolveExtent?.(result);

    expect(calledUrl(spy)).toContain("/lookup?");
    expect(calledUrl(spy)).toContain("id=gem-a1b3b381");
    expect(bbox).toEqual([6, 51, 7, 52]);
  });

  /**
   * An address's `geometrie_ll` is itself a POINT. There is no extent to frame,
   * so the caller falls back to the centroid — no type test needed in the
   * provider, because the WKT reader refuses a point outright.
   */
  it("returns undefined for a point-like hit", async () => {
    stubFetch(body([{ geometrie_ll: "POINT(6.16 51.36)" }]));

    await expect(pdokProvider.resolveExtent?.(result)).resolves.toBeUndefined();
  });

  it("returns undefined when the lookup finds nothing", async () => {
    stubFetch(body([]));

    await expect(pdokProvider.resolveExtent?.(result)).resolves.toBeUndefined();
  });
});
