import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

import { FeatureInfo } from "@/components/ui/feature-info";
import { initVariants } from "@/config/variant";
import { DOWNLOADS } from "@/lib/downloads";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import type { LayerEntry } from "@/hooks/use-map-layers";

/**
 * The Downloads row lives under the PBL summary, so reaching it means rendering
 * a pick result whose layer answers with `featureinfo.pbl`.
 */
const PICK_LAYER = {
  id: "buurt_klik",
  name: "Buurten",
  format: "pmtiles",
  source: "https://example.invalid/x.pmtiles",
  featureinfo: { pbl: true },
};

function pblResult(): FeatureInfoResult {
  return {
    screenX: 0,
    screenY: 0,
    featuresByLayer: new Map([
      ["buurt_klik", [{ properties: { bu_code: "BU00340101" } }]],
    ]),
  } as unknown as FeatureInfoResult;
}

const entries = [{ config: PICK_LAYER }] as unknown as LayerEntry[];

function renderInfo() {
  return render(() => (
    <FeatureInfo result={pblResult()} layerEntries={entries} embedded />
  ));
}

function downloadLinks(): HTMLAnchorElement[] {
  return Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/downloads/"]'),
  );
}

describe("FeatureInfo downloads section", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    initVariants({
      default: "2026",
      items: [
        { id: "2025", label: "Startanalyse 2025" },
        { id: "2026", label: "Startanalyse 2026" },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    initVariants(undefined);
  });

  it("offers every archive", () => {
    renderInfo();

    const links = downloadLinks();
    expect(links).toHaveLength(DOWNLOADS.length);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      DOWNLOADS.map((d) => `https://data.startanalyse2026.nl/downloads/${d.file}`),
    );
  });

  /**
   * The reason this is pinned: the app is embedded in an iframe on
   * startanalyse2026.nl, whose CSP is `default-src 'self'` with a frame-src
   * naming only the map host. Without a target the link navigates the frame
   * itself to the data host and the parent's policy blocks it — the user sees
   * "This content is blocked" instead of a download. A top-level navigation is
   * outside the parent frame's policy.
   */
  it("opens each download in a new context so the embedding page cannot block it", () => {
    renderInfo();

    for (const link of downloadLinks()) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }
  });

  it("names every link for assistive tech", () => {
    renderInfo();

    for (const link of downloadLinks()) {
      expect(link.getAttribute("aria-label")).toBeTruthy();
      expect(link.getAttribute("title")).toBeTruthy();
    }
  });

  /**
   * The inverse of what this once asserted. Each archive now holds both model
   * years, so the links must NOT change with the variant — a link that still
   * followed it would point at a `downloads/<year>/` path that no longer exists.
   */
  it("offers the same links whichever variant is active", () => {
    renderInfo();
    const under2026 = downloadLinks().map((a) => a.getAttribute("href"));
    cleanup();

    initVariants({
      default: "2025",
      items: [
        { id: "2025", label: "Startanalyse 2025" },
        { id: "2026", label: "Startanalyse 2026" },
      ],
    });
    renderInfo();

    expect(downloadLinks().map((a) => a.getAttribute("href"))).toEqual(under2026);
    for (const link of downloadLinks()) {
      expect(link.getAttribute("href")).not.toMatch(/\/20\d\d\//);
    }
  });

  // woonzorglimburg shares this component and publishes no archives.
  it("shows nothing where the project has no variants", () => {
    initVariants(undefined);
    renderInfo();

    expect(downloadLinks()).toHaveLength(0);
    expect(screen.queryByText("Downloads")).toBeNull();
  });
});

/**
 * The gemeente packages, unlike the archives, ARE year-specific: PBL publishes
 * them per model year at different URLs (one for 2025, buurt + gebouw for 2026).
 * So the active variant decides which year(s) the popup offers, and each button
 * names its year.
 */
describe("FeatureInfo gemeente datapakket", () => {
  const ALL_VARIANTS = [
    { id: "2025", label: "Startanalyse 2025" },
    { id: "2026", label: "Startanalyse 2026" },
    { id: "2025_2026", label: "Vergelijk 2025 / 2026" },
  ];

  function useVariant(id: string) {
    initVariants({ default: id, items: ALL_VARIANTS });
  }

  /** The gemeente links only — the archive links live on another host. */
  function gemeenteLinks(): HTMLAnchorElement[] {
    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="dataportaal.pbl.nl"]'),
    );
  }

  /**
   * A year label in the Downloads row, or null.
   *
   * Scoped past the PBL summary's own tab strip, which under the comparison
   * variant carries tabs with these exact two labels — so a bare
   * `getByText("ASA2025")` matches twice and throws.
   */
  function yearLabel(year: string): HTMLElement | null {
    return screen.queryAllByText(year).find((el) => !el.closest('[role="tab"]')) ?? null;
  }

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    initVariants(undefined);
  });

  it("offers the 2025 package, labelled, under the 2025 variant", () => {
    useVariant("2025");
    renderInfo();

    expect(yearLabel("ASA2025")).toBeTruthy();
    expect(yearLabel("ASA2026")).toBeNull();

    const links = gemeenteLinks();
    expect(links).toHaveLength(1);
    // BU0034… -> GM0034 -> Almere.
    expect(links[0].getAttribute("href")).toBe(
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Almere.zip",
    );
  });

  /**
   * 2026 publishes two packages per gemeente: CSV tables per buurt (by name) and
   * a GIS package per gebouw (by gemeente code). Each gets its own labelled
   * button.
   */
  it("offers the 2026 buurt and gebouw packages, labelled, under the 2026 variant", () => {
    useVariant("2026");
    renderInfo();

    expect(yearLabel("ASA2026")).toBeTruthy();
    expect(yearLabel("ASA2025")).toBeNull();
    expect(screen.getByText("Buurt")).toBeTruthy();
    expect(screen.getByText("Gebouw")).toBeTruthy();

    expect(gemeenteLinks().map((a) => a.getAttribute("href"))).toEqual([
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_buurtniveau/Almere.zip",
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_gebouwniveau/GM0034.zip",
    ]);
  });

  it("offers both years, each labelled, under the comparison variant", () => {
    useVariant("2025_2026");
    renderInfo();

    expect(yearLabel("ASA2025")).toBeTruthy();
    expect(yearLabel("ASA2026")).toBeTruthy();

    const hrefs = gemeenteLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Almere.zip",
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_buurtniveau/Almere.zip",
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_gebouwniveau/GM0034.zip",
    ]);
  });

  // A year with one package keeps the plain button: no kind label beside it.
  it("labels package kinds only where a year offers more than one", () => {
    useVariant("2025");
    renderInfo();

    expect(screen.queryByText("Buurt")).toBeNull();
    expect(screen.queryByText("Gebouw")).toBeNull();
  });

  /**
   * Ameland has no buurt package in either year, but does have a 2026 gebouw
   * package, so the comparison variant must show one live button beside two
   * disabled ones. Collapsing that to "no package for this gemeente" would hide a
   * download that exists.
   */
  it("disables only the packages a gemeente is missing from", () => {
    useVariant("2025_2026");
    render(() => (
      <FeatureInfo
        result={
          {
            screenX: 0,
            screenY: 0,
            // BU0060… -> GM0060 -> Ameland.
            featuresByLayer: new Map([
              ["buurt_klik", [{ properties: { bu_code: "BU00600101" } }]],
            ]),
          } as unknown as FeatureInfoResult
        }
        layerEntries={entries}
        embedded
      />
    ));

    // Only the 2026 gebouw package resolves to a link...
    const hrefs = gemeenteLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2026/Gemeentedata_op_gebouwniveau/GM0060.zip",
    ]);
    // ...and the buurt packages are present but rendered as unavailable rather
    // than dropped.
    expect(yearLabel("ASA2025")).toBeTruthy();
    expect(
      screen.getByLabelText("Geen datapakket ASA2025 beschikbaar voor deze gemeente"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Geen datapakket ASA2026 op buurtniveau beschikbaar voor deze gemeente",
      ),
    ).toBeTruthy();
  });

  /**
   * Two buttons side by side with identical names would be indistinguishable to a
   * screen reader, so the year has to reach the accessible name, not just the
   * adjacent text.
   */
  it("names each year in the accessible label", () => {
    useVariant("2025_2026");
    renderInfo();

    const labels = gemeenteLinks().map((a) => a.getAttribute("aria-label") ?? "");
    expect(labels.some((l) => l.includes("ASA2025"))).toBe(true);
    expect(labels.some((l) => l.includes("ASA2026"))).toBe(true);
    for (const link of gemeenteLinks()) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }
  });
});
