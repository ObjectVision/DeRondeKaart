import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMapConfig } from "@/config/map-config";
import { zoomToLocation } from "@/tools/zoom-to-location";

/**
 * The geocoder request, moved here with the logic it covers: this used to live
 * in map-controls.test.tsx, before `zoom_to_location` became a map tool the
 * command bar shares with the search box.
 *
 * Only the FIRST result is used, so an unrestricted search has no list for the
 * user to correct from — "Bergen" answers with Bergen in Norway, though it is
 * also a town in Noord-Holland and another in Limburg.
 * `mapControls.searchCountries` is what prevents that.
 */

/** Point `loadMapConfig` at a map.json body. */
function stubMapJson(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, statusText: "OK", json: async () => body })),
  );
}

/** Run a search and hand back the URL the geocoder was called with. */
async function searchFor(query: string): Promise<string> {
  const fetchSpy = vi.fn<(url: string) => Promise<{ json: () => Promise<unknown[]> }>>(
    async () => ({ json: async () => [] }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  await zoomToLocation(query);
  return String(fetchSpy.mock.calls[0]?.[0] ?? "");
}

describe("zoomToLocation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restricts to the configured countries", async () => {
    stubMapJson({ mapControls: { search: true, searchCountries: ["nl"] } });
    await loadMapConfig();
    vi.unstubAllGlobals();

    const url = await searchFor("Bergen");

    expect(url).toContain("countrycodes=nl");
    expect(url).toContain("q=Bergen");
  });

  /**
   * The case that protects woonzorglimburg, which names no countries: the
   * parameter must be absent entirely, not sent empty. `countrycodes=` would be
   * a filter matching nothing.
   */
  it("sends no countrycodes when none are configured", async () => {
    stubMapJson({ mapControls: { search: true } });
    await loadMapConfig();
    vi.unstubAllGlobals();

    const url = await searchFor("Bergen");

    expect(url).not.toContain("countrycodes");
  });

  it("joins several countries for a project spanning a border", async () => {
    stubMapJson({ mapControls: { search: true, searchCountries: ["nl", "de", "be"] } });
    await loadMapConfig();
    vi.unstubAllGlobals();

    const url = await searchFor("Aachen");

    expect(url).toContain("countrycodes=nl%2Cde%2Cbe");
  });

  it("reports failure when nothing is found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));

    await expect(zoomToLocation("Atlantis")).resolves.toBe(false);
  });

  it("reports failure rather than throwing when the geocoder errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(zoomToLocation("Venlo")).resolves.toBe(false);

    err.mockRestore();
  });

  it("does not call the geocoder for empty input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(zoomToLocation("   ")).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
