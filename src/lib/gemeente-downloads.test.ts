import { describe, expect, it } from "vitest";
import {
  GEMEENTE_FILE_COUNT,
  gemeenteCodeOf,
  gemeenteDownloadUrl,
} from "@/lib/gemeente-downloads";

describe("gemeenteCodeOf", () => {
  it("reads the gemeente out of a buurt code", () => {
    // BU1904 0213 -> Stichtse Vecht.
    expect(gemeenteCodeOf("BU19040213")).toBe("GM1904");
  });

  /**
   * Amsterdam's buurt halves are letter-led throughout. Only the gemeente half
   * is numeric, so a code that reads as non-numeric further along must still
   * resolve.
   */
  it("handles a letter-led buurt half", () => {
    expect(gemeenteCodeOf("BU0363FF03")).toBe("GM0363");
  });
});

describe("gemeenteDownloadUrl", () => {
  it("builds the URL for an ordinary gemeente", () => {
    expect(gemeenteDownloadUrl("GM0014", "2025")).toBe(
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Groningen.zip",
    );
  });

  // Many names contain a space; an unencoded URL is not a valid one.
  it("encodes a name containing a space", () => {
    expect(gemeenteDownloadUrl("GM1904", "2025")).toContain("Stichtse%20Vecht.zip");
  });

  /**
   * The four names no transform of a CBS name produces. Each was confirmed
   * against the live host; getting one wrong is a silent 404 for that gemeente.
   */
  it("uses the published spelling for the irregular names", () => {
    expect(gemeenteDownloadUrl("GM0893", "2025")).toContain("Bergen%20(L.).zip");
    expect(gemeenteDownloadUrl("GM0373", "2025")).toContain("Bergen%20(NH.).zip");
    // CBS calls this "Hengelo (O)"; PBL drops the suffix entirely.
    expect(gemeenteDownloadUrl("GM0164", "2025")).toContain("Hengelo.zip");
    // CBS spells this with commas.
    expect(gemeenteDownloadUrl("GM0820", "2025")).toContain(
      "Nuenen%20Gerwen%20en%20Nederwetten.zip",
    );
  });

  it("strips diacritics and a leading apostrophe, as PBL does", () => {
    // Sudwest-Fryslan, not Súdwest-Fryslân.
    expect(gemeenteDownloadUrl("GM1900", "2025")).toContain("Sudwest-Fryslan.zip");
    // s-Gravenhage, not 's-Gravenhage.
    expect(gemeenteDownloadUrl("GM0518", "2025")).toContain("/s-Gravenhage.zip");
  });

  /**
   * Ameland has no 2025 package, while every other Wadden island does. The caller
   * must be able to tell, so this returns null rather than a URL that would 404.
   */
  it("returns null for a gemeente PBL does not publish that year", () => {
    expect(gemeenteDownloadUrl("GM0060", "2025")).toBeNull();
  });

  /**
   * ...but PBL DOES publish Ameland for 2026, so availability is per-year and not
   * a property of the gemeente. Getting this wrong hides a download that exists.
   */
  it("resolves a gemeente that only a later year publishes", () => {
    expect(gemeenteDownloadUrl("GM0060", "2026")).toBe(
      "https://dataportaal.pbl.nl/Startanalyse_aardgasvrije_buurten/2026/Gemeentes/Ameland.zip",
    );
  });

  /**
   * The 2026 packages sit at a path with NO `/data/` segment, unlike 2025.
   * Confirmed against the live host in both directions. A "tidy-up" that unified
   * the two bases would 404 every link for one of the years, silently.
   */
  it("uses the 2026 base, which omits the /data/ segment", () => {
    expect(gemeenteDownloadUrl("GM0014", "2026")).toBe(
      "https://dataportaal.pbl.nl/Startanalyse_aardgasvrije_buurten/2026/Gemeentes/Groningen.zip",
    );
  });

  it("keeps the /data/ segment for 2025", () => {
    expect(gemeenteDownloadUrl("GM0014", "2025")).toContain("/data/");
    expect(gemeenteDownloadUrl("GM0014", "2026")).not.toContain("/data/");
  });

  // The filename table is shared across years, so encoding must hold for both.
  it("encodes irregular names for 2026 too", () => {
    expect(gemeenteDownloadUrl("GM0373", "2026")).toContain("Bergen%20(NH.).zip");
    expect(gemeenteDownloadUrl("GM1904", "2026")).toContain("Stichtse%20Vecht.zip");
  });

  it("returns null for an unknown code", () => {
    expect(gemeenteDownloadUrl("GM9999", "2025")).toBeNull();
    expect(gemeenteDownloadUrl("", "2025")).toBeNull();
  });
});

describe("the generated table", () => {
  // A regeneration that silently truncated would otherwise pass every test above.
  it("covers every gemeente that has a package", () => {
    expect(GEMEENTE_FILE_COUNT).toBe(341);
  });
});
