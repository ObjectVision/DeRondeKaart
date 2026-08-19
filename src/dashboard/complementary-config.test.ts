import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildComplementaryConfig, levelForZoom } from "@/dashboard/complementary-config";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const CONFIG = {
  gemeenteLayer: "gemeente_klik",
  buurtLayer: "buurt_klik",
  buurtZoom: 12,
  widgets: [{ kind: "statistic", ref: "inwoners" }],
};

describe("buildComplementaryConfig", () => {
  it("reads the layers, zoom and widgets", () => {
    const config = buildComplementaryConfig(CONFIG);
    expect(config.gemeenteLayer).toBe("gemeente_klik");
    expect(config.buurtLayer).toBe("buurt_klik");
    expect(config.buurtZoom).toBe(12);
    expect(config.widgets).toHaveLength(1);
  });

  it("falls back on an out-of-range zoom and drops invalid widgets", () => {
    const config = buildComplementaryConfig({
      ...CONFIG,
      buurtZoom: 99,
      widgets: [{ kind: "statistic" }, { kind: "chart", ref: "x" }],
    });
    expect(config.buurtZoom).toBe(12);
    // A statistic without a ref resolves against nothing.
    expect(config.widgets).toHaveLength(1);
  });

  it("defaults the code columns", () => {
    const config = buildComplementaryConfig({});
    expect(config.gemeenteCode).toBe("gm_code");
    expect(config.buurtCode).toBe("bu_code");
  });
});

describe("levelForZoom", () => {
  it("switches layer and code column at the threshold", () => {
    const config = buildComplementaryConfig(CONFIG);
    expect(levelForZoom(config, 11.9)).toEqual({
      layerId: "gemeente_klik",
      codeColumn: "gm_code",
    });
    expect(levelForZoom(config, 12)).toEqual({ layerId: "buurt_klik", codeColumn: "bu_code" });
  });

  it("is null for a level the project does not offer", () => {
    const config = buildComplementaryConfig({ ...CONFIG, gemeenteLayer: undefined });
    expect(levelForZoom(config, 8)).toBeNull();
    expect(levelForZoom(config, 14)).not.toBeNull();
  });
});
