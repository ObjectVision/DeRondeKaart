import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createComputed, createMemo, createRoot } from "solid-js";
import { buildShareUrl } from "./share-url";
import { initVariants, setVariant } from "@/config/variant";
import type { VariantsConfig } from "@/config/map-config";
import type { LayerEntry } from "@/hooks/use-map-layers";
import { addFilterLayer, getFilterLayers, removeFilterLayer } from "@/layers/filter-layers";
import { parseFilterLayerParam } from "@/layers/filter-layer-url";

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
  sides: {
    left: { entries: [entry("374")], hiddenIds: new Set<string>() },
    right: { entries: [], hiddenIds: new Set<string>() },
  },
};

/**
 * The `map=a|b` spelling is a published format — every link already shared
 * carries it, and use-url-commands parses the same keys back. The app calls the
 * sides "left" and "right" internally, so these pin that the rename stopped at
 * the wire.
 */
describe("share URL wire format", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
  });

  it("emits the left map as map=a", () => {
    const url = buildShareUrl(BASE_STATE, "https://example.org/");
    expect(url).toContain("cmd=add&map=a&layer=374");
  });

  it("emits the right map as map=b", () => {
    const url = buildShareUrl(
      {
        ...BASE_STATE,
        sides: {
          left: { entries: [], hiddenIds: new Set<string>() },
          right: { entries: [entry("357")], hiddenIds: new Set<string>() },
        },
      },
      "https://example.org/",
    );
    expect(url).toContain("cmd=add&map=b&layer=357");
    expect(url).not.toContain("map=a");
  });

  it("keeps each side's commands on its own map, in order", () => {
    const url = buildShareUrl(
      {
        ...BASE_STATE,
        sides: {
          left: { entries: [entry("374")], hiddenIds: new Set(["374"]) },
          right: { entries: [entry("357")], hiddenIds: new Set<string>() },
        },
      },
      "https://example.org/",
    );
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    expect(params.getAll("cmd")).toEqual(["add", "hide", "add"]);
    expect(params.getAll("map")).toEqual(["a", "a", "b"]);
    expect(params.getAll("layer")).toEqual(["374", "374", "357"]);
  });
});

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

/**
 * Combinations have no layers.json entry, so an `add` command alone cannot
 * resolve on the recipient's side — the definitions have to travel with it.
 */
describe("combination layers in the link", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    initVariants(undefined);
    for (const def of getFilterLayers()) removeFilterLayer(def.id);
  });

  function combiParam(url: string): string | null {
    return new URLSearchParams(new URL(url).hash.slice(1)).get("combi");
  }

  function stateWith(id: string) {
    return {
      ...BASE_STATE,
      sides: {
        left: { entries: [entry("374"), entry(id)], hiddenIds: new Set<string>() },
        right: { entries: [], hiddenIds: new Set<string>() },
      },
    };
  }

  it("carries the definition of a combination that is on a map", () => {
    const { def } = addFilterLayer("Combi", [{ layerId: "374", ruleName: "goed" }]);

    const url = buildShareUrl(stateWith(def.id), "https://example.org/");

    expect(parseFilterLayerParam(combiParam(url) ?? "")).toEqual([def]);
    // And the add command that consumes it.
    expect(url).toContain(`cmd=add&map=a&layer=${def.id}`);
  });

  it("leaves out a combination that is in the store but on neither map", () => {
    const { def } = addFilterLayer("Op de kaart", [{ layerId: "374", ruleName: "goed" }]);
    addFilterLayer("Alleen in de lijst", [{ layerId: "357", ruleName: "hoog" }]);

    const url = buildShareUrl(stateWith(def.id), "https://example.org/");

    const carried = parseFilterLayerParam(combiParam(url) ?? "");
    expect(carried?.map((item) => item.name)).toEqual(["Op de kaart"]);
  });

  it("omits the param when no combination is on a map, so ordinary links are unchanged", () => {
    addFilterLayer("Alleen in de lijst", [{ layerId: "357", ruleName: "hoog" }]);

    const url = buildShareUrl(BASE_STATE, "https://example.org/");

    expect(combiParam(url)).toBeNull();
    expect(url).not.toContain("combi");
  });

  it("carries an off-map combination that an on-map one is built on, source first", () => {
    const { def: source } = addFilterLayer("Bron", [{ layerId: "357", ruleName: "hoog" }]);
    const { def: dependent } = addFilterLayer("Afgeleid", [
      { layerId: source.id, ruleName: "1 van 1 criteria", score: 1 },
    ]);

    const url = buildShareUrl(stateWith(dependent.id), "https://example.org/");

    const carried = parseFilterLayerParam(combiParam(url) ?? "");
    expect(carried?.map((item) => item.id)).toEqual([source.id, dependent.id]);
    // Carried for the rebuild only: no add command puts the source on the map.
    expect(url).not.toContain(`layer=${source.id}&`);
    expect(url.endsWith(`layer=${source.id}`)).toBe(false);
  });
});
