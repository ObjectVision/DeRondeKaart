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
    expect(gemeenteDownloadUrl("GM0014")).toBe(
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Groningen.zip",
    );
  });

  // Many names contain a space; an unencoded URL is not a valid one.
  it("encodes a name containing a space", () => {
    expect(gemeenteDownloadUrl("GM1904")).toContain("Stichtse%20Vecht.zip");
  });

  /**
   * The four names no transform of a CBS name produces. Each was confirmed
   * against the live host; getting one wrong is a silent 404 for that gemeente.
   */
  it("uses the published spelling for the irregular names", () => {
    expect(gemeenteDownloadUrl("GM0893")).toContain("Bergen%20(L.).zip");
    expect(gemeenteDownloadUrl("GM0373")).toContain("Bergen%20(NH.).zip");
    // CBS calls this "Hengelo (O)"; PBL drops the suffix entirely.
    expect(gemeenteDownloadUrl("GM0164")).toContain("Hengelo.zip");
    // CBS spells this with commas.
    expect(gemeenteDownloadUrl("GM0820")).toContain(
      "Nuenen%20Gerwen%20en%20Nederwetten.zip",
    );
  });

  it("strips diacritics and a leading apostrophe, as PBL does", () => {
    // Sudwest-Fryslan, not Súdwest-Fryslân.
    expect(gemeenteDownloadUrl("GM1900")).toContain("Sudwest-Fryslan.zip");
    // s-Gravenhage, not 's-Gravenhage.
    expect(gemeenteDownloadUrl("GM0518")).toContain("/s-Gravenhage.zip");
  });

  /**
   * Ameland has no package upstream, while every other Wadden island does. The
   * caller must be able to tell, so this returns null rather than a URL that
   * would 404.
   */
  it("returns null for a gemeente PBL does not publish", () => {
    expect(gemeenteDownloadUrl("GM0060")).toBeNull();
  });

  it("returns null for an unknown code", () => {
    expect(gemeenteDownloadUrl("GM9999")).toBeNull();
    expect(gemeenteDownloadUrl("")).toBeNull();
  });
});

describe("the generated table", () => {
  // A regeneration that silently truncated would otherwise pass every test above.
  it("covers every gemeente that has a package", () => {
    expect(GEMEENTE_FILE_COUNT).toBe(341);
  });
});
