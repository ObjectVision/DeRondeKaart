import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildComplementaryConfig, levelForZoom } from "@/dashboard/complementary-config";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const CONFIG = {
  levels: [
    { layer: "selectie_gemeente", code: "gm_code", minzoom: 0 },
    { layer: "selectie_wijk", code: "wk_code", minzoom: 9 },
    { layer: "selectie_buurt", code: "bu_code", minzoom: 12 },
  ],
  widgets: [{ kind: "statistic", ref: "inwoners" }],
};

describe("buildComplementaryConfig", () => {
  it("reads the levels and widgets", () => {
    const config = buildComplementaryConfig(CONFIG);
    expect(config.levels.map((level) => level.layer)).toEqual([
      "selectie_gemeente",
      "selectie_wijk",
      "selectie_buurt",
    ]);
    expect(config.widgets).toHaveLength(1);
  });

  it("sorts levels by minzoom whatever order the file lists them in", () => {
    const config = buildComplementaryConfig({
      levels: [CONFIG.levels[2], CONFIG.levels[0], CONFIG.levels[1]],
    });
    expect(config.levels.map((level) => level.minzoom)).toEqual([0, 9, 12]);
  });

  it("drops levels without a layer or code, and invalid widgets", () => {
    const config = buildComplementaryConfig({
      levels: [{ layer: "x" }, { code: "gm_code" }, CONFIG.levels[0]],
      widgets: [{ kind: "statistic" }, { kind: "chart", ref: "x" }],
    });
    expect(config.levels).toHaveLength(1);
    // A statistic without a ref resolves against nothing.
    expect(config.widgets).toHaveLength(1);
  });

  it("yields an empty config for a non-object body", () => {
    expect(buildComplementaryConfig("nee").levels).toHaveLength(0);
  });
});

describe("levelForZoom", () => {
  it("takes the last level the zoom has reached", () => {
    const config = buildComplementaryConfig(CONFIG);
    expect(levelForZoom(config, 0)?.layer).toBe("selectie_gemeente");
    expect(levelForZoom(config, 8.9)?.layer).toBe("selectie_gemeente");
    expect(levelForZoom(config, 9)?.layer).toBe("selectie_wijk");
    expect(levelForZoom(config, 11.9)?.layer).toBe("selectie_wijk");
    expect(levelForZoom(config, 12)?.layer).toBe("selectie_buurt");
    expect(levelForZoom(config, 18)?.code).toBe("bu_code");
  });

  it("is null below the coarsest level and when there are none", () => {
    const config = buildComplementaryConfig({ levels: [CONFIG.levels[1], CONFIG.levels[2]] });
    expect(levelForZoom(config, 6)).toBeNull();
    expect(levelForZoom(buildComplementaryConfig({}), 12)).toBeNull();
  });
});
