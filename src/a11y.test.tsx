import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import axe, { type AxeResults, type Result } from "axe-core";

import { SearchBar } from "@/components/ui/SearchBar";
import { TabStrip } from "@/components/ui/tab-strip";
import { initVariants } from "@/config/variant";

/**
 * Automated accessibility regression net (WCAG 2.1 A + AA).
 *
 * Deliberately a NET, not a conformance proof: axe detects roughly a third of
 * WCAG issues, and none of the judgement-dependent ones — whether a label reads
 * sensibly, whether a colour carries meaning on its own, whether the keyboard
 * path to the map's data exists at all. Those live in
 * `docs/accessibility-wcag-assessment.md` and need a human.
 *
 * What this DOES buy: the five findings that are machine-checkable
 * (page language, contrast, input names, ARIA structure, aria-controls) cannot
 * silently regress once fixed.
 *
 * Run against components rather than the whole App: App mounts MapLibre, which
 * needs a WebGL context jsdom does not provide.
 */

/** The rule sets the Bdto requires, via EN 301 549 v3.2.1 -> WCAG 2.1 A + AA. */
const WCAG21_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * axe findings for a container, restricted to WCAG 2.1 A/AA.
 *
 * `resultTypes: ["violations"]` keeps axe from building the passes/incomplete
 * payloads, which it otherwise assembles in full and which this never reads.
 */
async function violations(container: HTMLElement): Promise<Result[]> {
  const results: AxeResults = await axe.run(container, {
    runOnly: { type: "tag", values: WCAG21_AA },
    resultTypes: ["violations"],
  });
  return results.violations;
}

/** axe's own summary, which names the element and the fix. */
function format(found: Result[]): string {
  return found
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`)
    .join("\n  ");
}

describe("accessibility — WCAG 2.1 AA", () => {
  afterEach(() => {
    cleanup();
    initVariants(undefined);
  });

  /**
   * F4 in the assessment: these inputs were labelled by `placeholder` alone,
   * which is neither an accessible name nor persistent once the user types.
   */
  it("gives the layer search input an accessible name", async () => {
    const { container } = render(() => <SearchBar showSearch />);

    const input = container.querySelector("input");
    expect(input?.getAttribute("aria-label")).toBeTruthy();

    const found = await violations(container);
    // `format` in the message so a failure names the element and the fix rather
    // than dumping axe's full result object.
    expect(found, format(found)).toEqual([]);
  });

  /**
   * F5, NOT YET FIXED — pinned as a known failure, not asserted as passing.
   *
   * `role="tab"` outside a `role="tablist"` is invalid ARIA, and axe reports it
   * as `aria-required-parent` (critical, WCAG 1.3.1, EN 301 549 9.1.3.1). The
   * fix is Stage 3 of the remediation plan: add the tablist/tabpanel wrapper and
   * arrow-key navigation, across all four TabStrip consumers.
   *
   * Written as an explicit expectation of the CURRENT broken state so the suite
   * stays green while the debt is visible. When Stage 3 lands this test FAILS,
   * which is the signal to flip it to `toEqual([])` — a skipped test would just
   * rot instead.
   */
  it("still has the known orphan-tab violation (fix: Stage 3 / F5)", async () => {
    const { container } = render(() => (
      <TabStrip
        tabs={[
          { id: "een", label: "Een" },
          { id: "twee", label: "Twee" },
        ]}
        active="een"
        onSelect={() => {}}
      />
    ));

    const found = await violations(container);
    expect(found.map((v) => v.id)).toEqual(["aria-required-parent"]);
  });
});

/**
 * F1: the page language. Asserted against the real index.html rather than a
 * rendered component, because that is where the attribute lives and where a
 * regression would actually happen.
 */
describe("accessibility — document", () => {
  it("declares Dutch as the page language", async () => {
    const fs = await import("node:fs/promises");
    const html = await fs.readFile("index.html", "utf-8");

    // The UI is Dutch throughout; `lang="en"` makes a screen reader apply
    // English pronunciation to all of it (WCAG 3.1.1).
    expect(html).toContain('<html lang="nl">');
  });

  /**
   * F6: the focus ring takes the project's chrome accent, which only a CSS
   * custom property can carry from runtime config into a static stylesheet.
   *
   * Both halves are pinned because either failing alone is silent: drop the
   * `setProperty` and every project falls back to the default blue; drop the
   * `var()` and the accent is published but unread.
   */
  it("bridges the chrome accent into CSS for the focus ring", async () => {
    const fs = await import("node:fs/promises");
    const [css, config] = await Promise.all([
      fs.readFile("src/index.css", "utf-8"),
      fs.readFile("src/config/map-config.ts", "utf-8"),
    ]);

    expect(config).toContain('setProperty("--chrome-icon-color"');
    expect(css).toContain("var(--chrome-icon-color, #3e74a7)");
  });

  /**
   * The Button primitive does NOT use the global outline: it sets `outline-none`
   * and draws its own `focus-visible:ring-ring/50` (button-variants.ts), which
   * covers 43 call sites. That ring reads `--ring`, which shadcn ships as a
   * neutral grey — so the accent has to reach this variable too, or every button
   * in the app focuses grey while everything else focuses in-theme.
   */
  it("points the Button ring variable at the chrome accent, not shadcn grey", async () => {
    const fs = await import("node:fs/promises");
    const css = await fs.readFile("src/index.css", "utf-8");

    const ringDecls = css.match(/^\s*--ring:.*$/gm) ?? [];
    // Both themes, light and dark.
    expect(ringDecls).toHaveLength(2);
    for (const decl of ringDecls) {
      expect(decl).toContain("var(--chrome-icon-color");
    }
  });

  /**
   * The ring must be drawn at FULL strength. Stock shadcn ships `ring-ring/50`,
   * but at 50% opacity the accent composites to 2.02:1 on white against the 3:1
   * floor of WCAG 1.4.11 — and since the same class sets `outline-none`, this
   * ring is the only focus indicator the button has.
   */
  it("draws the Button focus ring at full opacity", async () => {
    const fs = await import("node:fs/promises");
    const variants = await fs.readFile("src/components/ui/button-variants.ts", "utf-8");

    expect(variants).toContain("focus-visible:ring-ring");
    expect(variants).not.toContain("focus-visible:ring-ring/");
  });

  /**
   * F7 + F8: the map application had no landmark and no h1 — both h1s lived in
   * the dashboard/print paths — so a screen-reader user had nothing to navigate
   * by, and the skip link had no destination.
   *
   * Asserted against App.tsx source rather than a render: mounting App needs a
   * WebGL context jsdom does not provide.
   */
  it("gives the map app a main landmark, an h1 and a skip link", async () => {
    const fs = await import("node:fs/promises");
    const app = await fs.readFile("src/App.tsx", "utf-8");

    expect(app).toContain('<main id="kaart"');
    expect(app).toContain('<h1 class="sr-only">');
    // The skip link must target the nav landmark, which must be focusable for
    // the jump to move focus and not just scroll.
    expect(app).toContain('href="#hoofdnavigatie"');
    expect(app).toContain('id="hoofdnavigatie"');
    expect(app).toMatch(/<nav[\s\S]{0,200}tabindex=\{-1\}/);
    expect(app).toMatch(/<nav[\s\S]{0,200}aria-label=/);
  });

  /**
   * F10: `aria-expanded` tells a screen reader that something opened;
   * `aria-controls` is what says WHAT. Each of these pairs the state with the
   * region, and each omits the attribute while collapsed — pointing at an id
   * that is not in the DOM is itself a violation.
   */
  it("pairs aria-expanded with aria-controls on the disclosure controls", async () => {
    const fs = await import("node:fs/promises");
    const files = [
      "src/components/ui/navigation/NavTree.tsx",
      "src/components/ui/sidebar/NavigationSection.tsx",
      "src/components/ui/CombineLayersDialog.tsx",
      "src/components/annotations/AnnotationEditPopup.tsx",
    ];

    for (const path of files) {
      const source = await fs.readFile(path, "utf-8");
      expect(source, `${path} should declare aria-controls`).toContain("aria-controls=");
      // Ids come from createUniqueId, not from data: the same tree renders in
      // several places and a label- or path-derived id would collide.
      expect(source, `${path} should use createUniqueId`).toContain("createUniqueId");
    }
  });
});
