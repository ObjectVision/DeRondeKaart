import { afterEach, describe, expect, it, vi } from "vitest";

import {
  complementaryDashboardEnabled,
  loadMapConfig,
  standaloneDashboardEnabled,
} from "@/config/map-config";

/**
 * `loadMapConfig` fetches `/map.json` and writes module-level caches for the
 * icon accessors. Each test stubs fetch with its own body; nothing here reads
 * those caches, so the writes are harmless.
 */
function stubMapJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("map.json dashboard capability", () => {
  it("defaults to off when the key is absent", async () => {
    stubMapJson({ center: [5, 52], zoom: 7 });
    const config = await loadMapConfig();
    expect(config.dashboard).toBe("off");
  });

  it.each(["off", "standalone", "complementary", "both"] as const)(
    "accepts %s",
    async (value) => {
      stubMapJson({ dashboard: value });
      const config = await loadMapConfig();
      expect(config.dashboard).toBe(value);
    },
  );

  it("warns and falls back to off on an unknown value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMapJson({ dashboard: "dashboards-please" });
    const config = await loadMapConfig();
    expect(config.dashboard).toBe("off");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid "dashboard"'));
  });

  it("maps each mode to the two entry points", () => {
    expect(standaloneDashboardEnabled("off")).toBe(false);
    expect(standaloneDashboardEnabled("standalone")).toBe(true);
    expect(standaloneDashboardEnabled("complementary")).toBe(false);
    expect(standaloneDashboardEnabled("both")).toBe(true);

    expect(complementaryDashboardEnabled("off")).toBe(false);
    expect(complementaryDashboardEnabled("standalone")).toBe(false);
    expect(complementaryDashboardEnabled("complementary")).toBe(true);
    expect(complementaryDashboardEnabled("both")).toBe(true);
  });
});
