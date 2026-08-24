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

  it("offers every archive for the active variant", () => {
    renderInfo();

    const links = downloadLinks();
    expect(links).toHaveLength(DOWNLOADS.length);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      DOWNLOADS.map(
        (d) => `https://data.startanalyse2026.nl/downloads/2026/${d.file}`,
      ),
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

  it("follows the variant", () => {
    initVariants({
      default: "2025",
      items: [
        { id: "2025", label: "Startanalyse 2025" },
        { id: "2026", label: "Startanalyse 2026" },
      ],
    });
    renderInfo();

    for (const link of downloadLinks()) {
      expect(link.getAttribute("href")).toContain("/downloads/2025/");
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
