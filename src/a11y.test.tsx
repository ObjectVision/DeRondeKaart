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
});
