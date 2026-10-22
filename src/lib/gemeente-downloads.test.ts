import { describe, expect, it } from "vitest";
import {
  GEMEENTE_FILE_COUNT,
  gemeenteCodeOf,
  gemeentePackages,
  type GemeentePackageKind,
  type GemeenteYear,
} from "@/lib/gemeente-downloads";

/** The URL of one package kind, or null / undefined when absent. */
function urlOf(code: string, year: GemeenteYear, kind: GemeentePackageKind = "buurt") {
  return gemeentePackages(code, year).find((p) => p.kind === kind)?.url;
}

const BASE_2025 = "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes";
const BUURT_2026 =
  "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_buurtniveau";
const GEBOUW_2026 =
  "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_gebouwniveau";

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

describe("gemeentePackages", () => {
  it("offers one buurt package for 2025 and buurt + gebouw for 2026, in that order", () => {
    expect(gemeentePackages("GM0014", "2025").map((p) => p.kind)).toEqual(["buurt"]);
    expect(gemeentePackages("GM0014", "2026").map((p) => p.kind)).toEqual(["buurt", "gebouw"]);
  });

  it("builds the 2025 URL for an ordinary gemeente", () => {
    expect(urlOf("GM0014", "2025")).toBe(`${BASE_2025}/Groningen.zip`);
  });

  /**
   * PBL moved the 2026 packages. The old folder (`/2026/Gemeentes/`, no `/data/`)
   * still answers 200 — with an HTML "niet gevonden" page — so a stale base would
   * hand users an HTML file named .zip without any error to notice.
   */
  it("builds the 2026 buurt URL in Gemeentedata_op_buurtniveau, by name", () => {
    expect(urlOf("GM0014", "2026")).toBe(`${BUURT_2026}/Groningen.zip`);
    expect(urlOf("GM0014", "2026")).not.toContain("/2026/Gemeentes/");
  });

  it("builds the 2026 gebouw URL in Gemeentedata_op_gebouwniveau, by gemeente code", () => {
    expect(urlOf("GM0014", "2026", "gebouw")).toBe(`${GEBOUW_2026}/GM0014.zip`);
  });

  // Many names contain a space; an unencoded URL is not a valid one.
  it("encodes a name containing a space", () => {
    expect(urlOf("GM1904", "2025")).toContain("Stichtse%20Vecht.zip");
    expect(urlOf("GM1904", "2026")).toContain("Stichtse%20Vecht.zip");
  });

  /**
   * The four names no transform of a CBS name produces. Each was confirmed
   * against the live host; getting one wrong is a silent 404 for that gemeente.
   */
  it("uses the published spelling for the irregular names", () => {
    expect(urlOf("GM0893", "2025")).toContain("Bergen%20(L.).zip");
    expect(urlOf("GM0373", "2025")).toContain("Bergen%20(NH.).zip");
    // CBS calls this "Hengelo (O)"; PBL drops the suffix entirely.
    expect(urlOf("GM0164", "2025")).toContain("Hengelo.zip");
    // CBS spells this with commas.
    expect(urlOf("GM0820", "2025")).toContain("Nuenen%20Gerwen%20en%20Nederwetten.zip");
    // The 2026 buurt folder uses the same names.
    expect(urlOf("GM0373", "2026")).toContain("Bergen%20(NH.).zip");
  });

  it("strips diacritics and a leading apostrophe, as PBL does", () => {
    // Sudwest-Fryslan, not Súdwest-Fryslân.
    expect(urlOf("GM1900", "2025")).toContain("Sudwest-Fryslan.zip");
    // s-Gravenhage, not 's-Gravenhage.
    expect(urlOf("GM0518", "2025")).toContain("/s-Gravenhage.zip");
  });

  /**
   * Ameland has no buurt package in either year, but does have a 2026 gebouw
   * package. Availability is per package, not a property of the gemeente:
   * getting it wrong either links a 404 or hides a download that exists.
   */
  it("handles Ameland per package", () => {
    expect(urlOf("GM0060", "2025")).toBeNull();
    expect(urlOf("GM0060", "2026")).toBeNull();
    expect(urlOf("GM0060", "2026", "gebouw")).toBe(`${GEBOUW_2026}/GM0060.zip`);
  });

  // Still one entry per package, so the caller can grey it out in place.
  it("keeps an entry for an unpublished package", () => {
    expect(gemeentePackages("GM0060", "2026")).toHaveLength(2);
  });

  it("returns no URL for an unknown code", () => {
    for (const code of ["GM9999", ""]) {
      expect(gemeentePackages(code, "2025").every((p) => p.url === null)).toBe(true);
      expect(gemeentePackages(code, "2026").every((p) => p.url === null)).toBe(true);
    }
  });
});

describe("the generated table", () => {
  // A regeneration that silently truncated would otherwise pass every test above.
  it("covers every gemeente that has a package", () => {
    expect(GEMEENTE_FILE_COUNT).toBe(341);
  });
});
