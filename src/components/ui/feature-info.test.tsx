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
 * The gemeente package, unlike the archives, IS year-specific: PBL publishes one
 * per model year, at two different base URLs. So the active variant decides which
 * year(s) the popup offers, and each button names its year.
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

    expect(screen.getByText("ASA2025")).toBeTruthy();
    expect(screen.queryByText("ASA2026")).toBeNull();

    const links = gemeenteLinks();
    expect(links).toHaveLength(1);
    // BU0034… -> GM0034 -> Almere.
    expect(links[0].getAttribute("href")).toBe(
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Almere.zip",
    );
  });

  it("offers the 2026 package, labelled, under the 2026 variant", () => {
    useVariant("2026");
    renderInfo();

    expect(screen.getByText("ASA2026")).toBeTruthy();
    expect(screen.queryByText("ASA2025")).toBeNull();

    const links = gemeenteLinks();
    expect(links).toHaveLength(1);
    // The 2026 base has no `/data/` segment; see gemeente-downloads.ts.
    expect(links[0].getAttribute("href")).toBe(
      "https://dataportaal.pbl.nl/Startanalyse_aardgasvrije_buurten/2026/Gemeentes/Almere.zip",
    );
  });

  it("offers both years, each labelled, under the comparison variant", () => {
    useVariant("2025_2026");
    renderInfo();

    expect(screen.getByText("ASA2025")).toBeTruthy();
    expect(screen.getByText("ASA2026")).toBeTruthy();

    const hrefs = gemeenteLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://dataportaal.pbl.nl/data/Startanalyse_aardgasvrije_buurten/2025/Gemeentes/Almere.zip",
      "https://dataportaal.pbl.nl/Startanalyse_aardgasvrije_buurten/2026/Gemeentes/Almere.zip",
    ]);
  });

  /**
   * Ameland has a 2026 package but no 2025 one, so the comparison variant must
   * show one live button beside one disabled one. Collapsing that to "no package
   * for this gemeente" would hide a download that exists.
   */
  it("disables only the year a gemeente is missing from", () => {
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

    // Only 2026 resolves to a link...
    const hrefs = gemeenteLinks().map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://dataportaal.pbl.nl/Startanalyse_aardgasvrije_buurten/2026/Gemeentes/Ameland.zip",
    ]);
    // ...and 2025 is present but rendered as unavailable rather than dropped.
    expect(screen.getByText("ASA2025")).toBeTruthy();
    expect(
      screen.getByLabelText("Geen datapakket ASA2025 beschikbaar voor deze gemeente"),
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
