import { describe, it, expect } from "vitest";
import { DOWNLOADS, downloadUrl } from "@/lib/downloads";

/**
 * The icon-to-archive pairing is asserted here because it cannot be checked by
 * reading the names: two entries pair a flag with a differently-named file, and
 * a link that points at a missing archive fails as a 404 the user only sees
 * after clicking.
 */
describe("DOWNLOADS", () => {
  it("offers one archive per strategy flag", () => {
    expect(DOWNLOADS).toHaveLength(8);
    expect(DOWNLOADS.map((d) => d.icon)).toEqual([
      "LN.svg",
      "GLN.svg",
      "S1.svg",
      "S2.svg",
      "S3.svg",
      "S4.svg",
      "R23.svg",
      "R30.svg",
    ]);
  });

  // The archive is ref23 while the map layer is still served from
  // ref19.pmtiles: the download was renamed, the tile source was not. Pointing
  // this back at ref19.zip would 404.
  it("pairs the 2023 reference flag with ref23", () => {
    expect(DOWNLOADS.find((d) => d.icon === "R23.svg")?.file).toBe("ref23.zip");
  });

  // The eleven sensitivity runs are published as one merged archive.
  it("pairs the sensitivity flag with the merged LNGA archive", () => {
    expect(DOWNLOADS.find((d) => d.icon === "GLN.svg")?.file).toBe("LNGA.zip");
  });

  it("names a distinct archive and a distinct icon for every entry", () => {
    expect(new Set(DOWNLOADS.map((d) => d.file)).size).toBe(DOWNLOADS.length);
    expect(new Set(DOWNLOADS.map((d) => d.icon)).size).toBe(DOWNLOADS.length);
  });

  it("labels every entry for the screen reader and the tooltip", () => {
    for (const item of DOWNLOADS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon).toMatch(/\.svg$/);
      expect(item.file).toMatch(/\.zip$/);
    }
  });
});

describe("downloadUrl", () => {
  it("points at the archive for the variant it is given", () => {
    expect(downloadUrl("2026", "LNGA.zip")).toBe(
      "https://data.startanalyse2026.nl/downloads/2026/LNGA.zip",
    );
  });

  // The same filename under either year — switching variants must re-point
  // every link, not just some.
  it("keeps the filename and swaps only the variant", () => {
    for (const item of DOWNLOADS) {
      const a = downloadUrl("2025", item.file);
      const b = downloadUrl("2026", item.file);
      expect(a).toBe(b.replace("/2026/", "/2025/"));
      expect(a.endsWith(`/${item.file}`)).toBe(true);
    }
  });
});
