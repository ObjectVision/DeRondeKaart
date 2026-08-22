import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createComputed, createMemo, createRoot } from "solid-js";
import { buildShareUrl } from "./share-url";
import { initVariants, setVariant } from "@/config/variant";
import type { VariantsConfig } from "@/config/map-config";
import type { LayerEntry } from "@/hooks/use-map-layers";

const VARIANTS: VariantsConfig = {
  default: "2025",
  items: [
    { id: "2025", label: "Startanalyse 2025" },
    { id: "2026", label: "Startanalyse 2026" },
  ],
};

function entry(id: string): LayerEntry {
  return { config: { id, name: id, format: "mvt" } } as LayerEntry;
}

const BASE_STATE = {
  viewState: { longitude: 5, latitude: 52, zoom: 7 },
  entriesA: [entry("374")],
  entriesB: [],
  hiddenIdsA: new Set<string>(),
  hiddenIdsB: new Set<string>(),
};

describe("share URL and config variants", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("omits the variant for a project that declares none", () => {
    const url = buildShareUrl(BASE_STATE, "https://example.org/");
    expect(url).not.toContain("variant=");
  });

  it("carries the active variant", () => {
    initVariants(VARIANTS);
    expect(buildShareUrl(BASE_STATE, "https://example.org/")).toContain("variant=2025");
  });

  it("carries the variant the user switched to", () => {
    initVariants(VARIANTS);
    setVariant("2026");
    const url = buildShareUrl(BASE_STATE, "https://example.org/");
    expect(url).toContain("variant=2026");
    expect(url).not.toContain("variant=2025");
  });

  // The ShareDialog builds its link inside a createMemo. buildShareUrl reads
  // variantId() itself, so that read is tracked and the displayed link must
  // update on a switch — without the dialog knowing variants exist. A link
  // left showing the old year would send the recipient to the wrong dataset,
  // since layer ids are reused across variants.
  it("recomputes a memoized link when the variant changes", () => {
    initVariants(VARIANTS);
    // Read from inside a tracked scope, the way ShareDialog consumes it.
    // `createRoot` runs its body synchronously, so the assertions can too.
    createRoot((dispose) => {
      const seen: string[] = [];
      const url = createMemo(() => buildShareUrl(BASE_STATE, "https://example.org/"));
      createComputed(() => {
        seen.push(url());
      });

      expect(seen.at(-1)).toContain("variant=2025");
      setVariant("2026");
      expect(seen.at(-1)).toContain("variant=2026");

      dispose();
    });
  });
});
