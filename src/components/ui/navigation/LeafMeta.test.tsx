import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { LeafMeta, clearMetaUrlCache } from "@/components/ui/navigation/LeafMeta";

/**
 * The catalogue the mocked `@/layers` serves. Mutable so each case can register
 * the layer it needs — the mock factory is hoisted above every `const`, so it
 * cannot close over a per-test value any other way.
 */
const catalogue = new Map<string, { id: string; name: string; meta: unknown }>();

vi.mock("@/layers", () => ({
  loadLayerConfigs: async () => [...catalogue.values()],
  getLayerConfigById: (_configs: unknown, id: string) => catalogue.get(id),
}));

/**
 * Register a layer and stub `fetch` to serve `documents`. A URL that is absent
 * from the map 404s, which is how the "all fragments failed" case is set up.
 *
 * Ids and URLs must be unique per case: LeafMeta's caches are module-level and
 * live for the whole file, by design — a shared fragment is fetched once for
 * every layer that names it.
 */
function stub(
  id: string,
  meta: unknown,
  documents: Record<string, string>,
): void {
  catalogue.set(id, { id, name: id, meta });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url in documents
        ? { ok: true, statusText: "OK", text: async () => documents[url] }
        : { ok: false, statusText: "Not Found", text: async () => "" },
    ),
  );
}

/** Render the layer and wait until its panel has painted. */
async function open(id: string): Promise<void> {
  render(() => <LeafMeta layerId={id} onAddLayer={() => {}} isLayerOnMap={() => false} />);
  await vi.waitFor(() => {
    expect(document.querySelector("div.prose")).toBeTruthy();
  });
}

function tabLabels(): string[] {
  return Array.from(document.querySelectorAll('button[role="tab"]')).map(
    (tab) => tab.textContent ?? "",
  );
}

function panelHtml(): string {
  return document.querySelector("div.prose")?.innerHTML ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  catalogue.clear();
  clearMetaUrlCache();
});

/**
 * Which lists lose their bullets.
 *
 * `prose` is told to strip markers and indentation from the "Gerelateerde
 * kaartlagen" rows in the startanalyse2026 documents — those `<li>`s hold a
 * thumbnail and a link, not running text. That override used to apply to EVERY
 * list, which was invisible while those documents were the only ones the app
 * rendered.
 *
 * The generated woonzorglimburg fragments (data/meta) use ordinary
 * bullet lists for running text, so an un-narrowed override silently flattens
 * the woning-geschiktheid definitions into one run-on block. Nothing errors and
 * nothing logs — the bullets are simply gone — which is why it is pinned here.
 */
describe("LeafMeta list styling", () => {
  async function metaClasses(id: string): Promise<string> {
    stub(id, `/${id}.html`, { [`/${id}.html`]: "<ul><li>een opsomming</li></ul>" });
    await open(id);
    return document.querySelector("div.prose")?.className ?? "";
  }

  /**
   * The failure this guards is a revert to the broad selector. `[&_ul]:list-none`
   * reads as a harmless tidy-up and would pass every other test in the suite.
   */
  it("strips bullets only from the Bootstrap list-group rows", async () => {
    const classes = await metaClasses("stijl_a");

    // Narrowed: keyed on the row class the published documents carry.
    expect(classes).toContain("[&_ul:has(>li.list-group-item)]:list-none");
    expect(classes).toContain("[&_li.list-group-item]:before:hidden");

    // Broad: would flatten the generated fragments' own bullet lists.
    expect(classes).not.toContain("[&_ul]:list-none");
    expect(classes).not.toContain("[&_ul]:pl-0");
    expect(classes).not.toContain("[&_li]:before:hidden");
  });

  // The thumbnail rows still need their flex layout and tightened spacing;
  // narrowing the bullet rules must not have taken those with it.
  it("keeps the layout overrides for those same rows", async () => {
    const classes = await metaClasses("stijl_b");

    expect(classes).toContain("[&_li.list-group-item]:flex");
    expect(classes).toContain("[&_li.list-group-item]:my-0");
    expect(classes).toContain("[&_li.list-group-item_img]:my-0");
  });
});

/**
 * The dialog's tabs.
 *
 * What makes a tab appear is not the key being present in `meta` but the route
 * having a document to show, and that is decided in two places: the config (no
 * key, no tab) and the fetch (every fragment failed, no tab). Both are pinned
 * here, because either failing produces a tab that opens on nothing — which
 * reads as the app being broken rather than as the metadata being unwritten.
 */
describe("LeafMeta tabs", () => {
  it("shows one tab per route, in a fixed order whatever the JSON says", async () => {
    stub(
      "drie",
      {
        bronnen: "/drie_b.html",
        toelichting: "/drie_t.html",
        aannames_en_onzekerheden: "/drie_a.html",
      },
      {
        "/drie_t.html": "<p>toelichting</p>",
        "/drie_b.html": "<p>bronnen</p>",
        "/drie_a.html": "<p>aannames</p>",
      },
    );
    await open("drie");

    expect(tabLabels()).toEqual(["Toelichting", "Bronnen", "Aannames en onzekerheden"]);
    // The first tab is the one on show.
    expect(panelHtml()).toContain("toelichting");
  });

  // aandeel_j0_17 is exactly this case today: its spreadsheet row has no
  // "Aannames en Onzekerheden", so the generator writes no such file.
  it("shows no tab for a route the config does not name", async () => {
    stub(
      "twee",
      { toelichting: "/twee_t.html", bronnen: "/twee_b.html" },
      { "/twee_t.html": "<p>toelichting</p>", "/twee_b.html": "<p>bronnen</p>" },
    );
    await open("twee");

    expect(tabLabels()).toEqual(["Toelichting", "Bronnen"]);
  });

  /**
   * A route can also be empty at load time — a path that 404s. The tab must go
   * with it, rather than opening on a blank panel.
   */
  it("shows no tab for a route whose fragments all fail to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(
      "kapot",
      { toelichting: "/kapot_t.html", bronnen: "/kapot_weg.html" },
      { "/kapot_t.html": "<p>toelichting</p>" },
    );
    await open("kapot");

    expect(tabLabels()).toEqual(["Toelichting"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("/kapot_weg.html"),
      expect.anything(),
    );
  });

  // A route that loses one fragment of several still has something to show.
  it("keeps a route whose other fragments loaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(
      "deels",
      { toelichting: ["/deels_ok.html", "/deels_weg.html"] },
      { "/deels_ok.html": "<p>wel geladen</p>" },
    );
    await open("deels");

    expect(tabLabels()).toEqual(["Toelichting"]);
    expect(panelHtml()).toContain("wel geladen");
  });

  it("swaps the panel when another tab is clicked", async () => {
    stub(
      "wissel",
      { toelichting: "/wissel_t.html", bronnen: "/wissel_b.html" },
      { "/wissel_t.html": "<p>de toelichting</p>", "/wissel_b.html": "<p>de bronnen</p>" },
    );
    await open("wissel");
    expect(panelHtml()).toContain("de toelichting");

    document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[1].click();

    await vi.waitFor(() => {
      expect(panelHtml()).toContain("de bronnen");
    });
    expect(panelHtml()).not.toContain("de toelichting");
  });

  /**
   * startanalyse2026 was not rewritten for any of this: its ~600 layers still
   * spell `meta` as an array of a layer-specific head and shared tails. That
   * has to keep rendering as one document under one tab, or adding tabs here
   * would blank the metainfo of another project entirely.
   */
  it("renders a legacy array as one Toelichting tab, fragments in order", async () => {
    stub(
      "oud",
      ["/oud_kop.html", "/oud_staart.html"],
      { "/oud_kop.html": "<p>kop</p>", "/oud_staart.html": "<p>staart</p>" },
    );
    await open("oud");

    expect(tabLabels()).toEqual(["Toelichting"]);
    const html = panelHtml();
    expect(html).toContain("kop");
    expect(html).toContain("staart");
    expect(html.indexOf("kop")).toBeLessThan(html.indexOf("staart"));
  });

  it("says so when a layer has no metainfo at all", async () => {
    catalogue.set("niets", { id: "niets", name: "niets", meta: undefined });
    vi.stubGlobal("fetch", vi.fn());
    render(() => <LeafMeta layerId="niets" />);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Geen informatie beschikbaar");
    });
    expect(tabLabels()).toEqual([]);
  });
});
