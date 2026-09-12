import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { LeafMeta } from "@/components/ui/navigation/LeafMeta";

/**
 * Which lists lose their bullets.
 *
 * `prose` is told to strip markers and indentation from the "Gerelateerde
 * kaartlagen" rows in the startanalyse2026 documents — those `<li>`s hold a
 * thumbnail and a link, not running text. That override used to apply to EVERY
 * list, which was invisible while those documents were the only ones the app
 * rendered.
 *
 * The generated woonzorglimburg fragments (scripts/metainfo) use ordinary
 * bullet lists for running text, so an un-narrowed override silently flattens
 * the woning-geschiktheid definitions into one run-on block. Nothing errors and
 * nothing logs — the bullets are simply gone — which is why it is pinned here.
 */

/**
 * One layer with a meta document. The component only renders its styled
 * container once a fragment has actually arrived, so an empty catalogue would
 * leave nothing to inspect.
 */
const LAYER = { id: "huisarts", name: "huisarts", meta: "/data/meta/huisarts.html" };

vi.mock("@/layers", () => ({
  loadLayerConfigs: async () => [LAYER],
  getLayerConfigById: (_configs: unknown, id: string) =>
    id === LAYER.id ? LAYER : undefined,
}));

/** Render the component and hand back the container's class string. */
async function metaClasses(): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      statusText: "OK",
      text: async () => "<ul><li>een opsomming</li></ul>",
    })),
  );
  render(() => (
    <LeafMeta layerId={LAYER.id} onAddLayer={() => {}} isLayerOnMap={() => false} />
  ));
  await vi.waitFor(() => {
    const el = document.querySelector("div.prose");
    expect(el).toBeTruthy();
    return el;
  });
  return document.querySelector("div.prose")?.className ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LeafMeta list styling", () => {
  /**
   * The failure this guards is a revert to the broad selector. `[&_ul]:list-none`
   * reads as a harmless tidy-up and would pass every other test in the suite.
   */
  it("strips bullets only from the Bootstrap list-group rows", async () => {
    const classes = await metaClasses();

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
    const classes = await metaClasses();

    expect(classes).toContain("[&_li.list-group-item]:flex");
    expect(classes).toContain("[&_li.list-group-item]:my-0");
    expect(classes).toContain("[&_li.list-group-item_img]:my-0");
  });
});
