import { describe, expect, it } from "vitest";

import { META_ROUTES, normalizeMetaRoutes } from "@/layers/meta-routes";

/**
 * Every spelling of `meta` has to arrive at the dialog as the same shape, so
 * LeafMeta only ever handles routes. The two that matter most are the ones no
 * config was rewritten for: startanalyse2026's arrays and this project's one
 * hand-authored string.
 */
describe("normalizeMetaRoutes", () => {
  it("turns a plain string into a single Toelichting tab", () => {
    expect(normalizeMetaRoutes("/data/meta/woningbouwkaart.html")).toEqual([
      {
        id: "toelichting",
        label: "Toelichting",
        urls: ["/data/meta/woningbouwkaart.html"],
      },
    ]);
  });

  /**
   * startanalyse2026 composes a document from a layer-specific head and several
   * shared tails. That composition is preserved inside the one tab — the array
   * is the tab's fragments, not a list of tabs.
   */
  it("keeps an array's order as one tab's fragments", () => {
    const routes = normalizeMetaRoutes(["LN_default.html", "_strategie1.html", "_footer.html"]);

    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("toelichting");
    expect(routes[0].urls).toEqual(["LN_default.html", "_strategie1.html", "_footer.html"]);
  });

  it("reads the object form as tabs, in META_ROUTES order", () => {
    // Deliberately written in the wrong order: the JSON's key order must not
    // decide which tab comes first.
    const routes = normalizeMetaRoutes({
      bronnen: "/b.html",
      aannames_en_onzekerheden: "/c.html",
      toelichting: "/a.html",
    });

    expect(routes.map((route) => route.id)).toEqual(META_ROUTES.map((route) => route.id));
    expect(routes.map((route) => route.urls)).toEqual([["/a.html"], ["/b.html"], ["/c.html"]]);
  });

  it("composes a route from several fragments, like the legacy array", () => {
    const routes = normalizeMetaRoutes({ bronnen: ["/eigen.html", "/gedeeld.html"] });

    expect(routes).toEqual([
      { id: "bronnen", label: "Bronnen", urls: ["/eigen.html", "/gedeeld.html"] },
    ]);
  });

  /**
   * The config-time half of "an empty route shows no tab" — the other half is a
   * route whose fragments all fail to load, which only LeafMeta can know.
   */
  it("drops a route with no fragments", () => {
    const routes = normalizeMetaRoutes({ toelichting: "/a.html", bronnen: [] });

    expect(routes.map((route) => route.id)).toEqual(["toelichting"]);
  });

  it("returns nothing for a layer without meta", () => {
    expect(normalizeMetaRoutes(undefined)).toEqual([]);
    expect(normalizeMetaRoutes("")).toEqual([]);
    expect(normalizeMetaRoutes([])).toEqual([]);
    expect(normalizeMetaRoutes({})).toEqual([]);
  });
});
