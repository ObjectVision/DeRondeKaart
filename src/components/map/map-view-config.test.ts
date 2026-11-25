import { describe, expect, it } from "vitest";
import { ofmProxyUrl } from "./map-view-config";

describe("ofmProxyUrl", () => {
  const origin = "https://map.example.nl";

  it("routes every OpenFreeMap resource through /ofm/ on the page origin", () => {
    expect(ofmProxyUrl("https://tiles.openfreemap.org/planet", origin)).toBe(`${origin}/ofm/planet`);
    expect(ofmProxyUrl("https://tiles.openfreemap.org/planet/20261122_124456_pt/10/525/336.pbf", origin)).toBe(
      `${origin}/ofm/planet/20261122_124456_pt/10/525/336.pbf`,
    );
    expect(ofmProxyUrl("https://tiles.openfreemap.org/sprites/ofm_f384/ofm@2x.json", origin)).toBe(
      `${origin}/ofm/sprites/ofm_f384/ofm@2x.json`,
    );
    expect(ofmProxyUrl("https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf", origin)).toBe(
      `${origin}/ofm/fonts/Noto%20Sans%20Regular/0-255.pbf`,
    );
  });

  it("leaves every other URL alone", () => {
    expect(ofmProxyUrl("https://data.derondekaart.nl/pmtiles/x.pmtiles", origin)).toBeNull();
    expect(ofmProxyUrl("https://service.pdok.nl/hwh/luchtfotorgb/wmts", origin)).toBeNull();
    expect(ofmProxyUrl("pmtiles://https://tiles.openfreemap.org/x", origin)).toBeNull();
    expect(ofmProxyUrl(`${origin}/positron-base.json`, origin)).toBeNull();
  });

  it("defaults to the page's own origin", () => {
    expect(ofmProxyUrl("https://tiles.openfreemap.org/planet")).toBe(`${window.location.origin}/ofm/planet`);
  });
});
