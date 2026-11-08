import { describe, expect, it, vi } from "vitest";

import {
  escapeHtml,
  formatValue,
  renderEscapedTemplate,
  renderLocationInfo,
} from "@/layers/location-info-template";

function fragment(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("placeholders", () => {
  it("escapes every substituted value", () => {
    const html = renderEscapedTemplate("<b>[[ naam ]]</b>", { naam: '<img src=x onerror="alert(1)">' });
    expect(html).toBe("<b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>");
    expect(escapeHtml("a & 'b'")).toBe("a &amp; &#39;b&#39;");
  });

  it("formats values and marks missing ones", () => {
    expect(formatValue(null)).toBe("–");
    expect(formatValue(undefined, "pct")).toBe("–");
    expect(formatValue("")).toBe("–");
    expect(formatValue(18.25, "pct")).toBe("18,3%");
    expect(formatValue(1430, "m")).toBe("1.430 meter");
    expect(formatValue(1234.5, "int")).toBe("1.235");
    expect(formatValue(3, "dec1")).toBe("3");
    expect(formatValue("6211ab", "postcode")).toBe("6211 AB");
    expect(formatValue("onbekend", "postcode")).toBe("onbekend");
    expect(formatValue("tekst", "bestaat_niet")).toBe("tekst");
    expect(renderEscapedTemplate("[[ a|pct ]] [[a]]", { a: 45 })).toBe("45% 45");
  });
});

describe("renderLocationInfo", () => {
  const TEMPLATE = `
    <div data-locationinfo="general"><b>[[ pc6 | postcode ]]</b></div>
    <section data-tab="gebouw" data-label="Gebouw" data-icon="home_work">bouwjaar [[ bouwjaar ]]</section>
    <section data-tab="kaartlagen" data-label="Gereserveerd">x</section>
    <section data-tab="bewoners" data-label="Bewoners">[[ oosr | dec1 ]]<script>alert(1)</script></section>
    <p data-locationinfo="footer">voet</p>`;

  it("splits the template into general block, tabs in order, and footer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = renderLocationInfo(TEMPLATE, { pc6: "6211AB", bouwjaar: "1970-1980", oosr: 3.04 });
    expect(r.general).toBe("<b>6211 AB</b>");
    expect(r.footer).toBe("voet");
    expect(r.tabs.map((t) => [t.id, t.label, t.icon])).toEqual([
      ["gebouw", "Gebouw", "home_work"],
      ["bewoners", "Bewoners", undefined],
    ]);
    expect(r.tabs[0].html).toBe("bouwjaar 1970-1980");
    // Scripts are removed, not left in as dead markup.
    expect(r.tabs[1].html).toBe("3");
  });

  it("draws a pie normalised to its slices, with an accessible label", () => {
    const r = renderLocationInfo(
      `<section data-tab="t"><div data-pie data-pie-label="Geschiktheid">
        <i data-slice="a" data-color="rgb(1,2,3)" data-name="Nultrede"></i>
        <i data-slice="b" data-color="red" data-name="Ongeschikt"></i>
      </div></section>`,
      { a: 30, b: 10 },
    );
    const pie = fragment(r.tabs[0].html).querySelector<HTMLElement>("[data-pie]")!;
    expect(pie.querySelector("[data-slice]")).toBeNull();
    expect(pie.getAttribute("role")).toBe("img");
    expect(pie.getAttribute("aria-label")).toBe("Geschiktheid: Nultrede 75%, Ongeschikt 25%");
    expect(pie.style.background).toContain("75.00%");
  });

  it("shows an empty pie when every slice is zero or missing", () => {
    const r = renderLocationInfo(
      `<section data-tab="t"><div data-pie data-pie-label="Leeftijd"><i data-slice="a"></i></div></section>`,
      {},
    );
    const pie = fragment(r.tabs[0].html).querySelector<HTMLElement>("[data-pie]")!;
    expect(pie.getAttribute("aria-label")).toBe("Leeftijd: geen gegevens");
  });

  it("colours distances by their breaks", () => {
    const r = renderLocationInfo(
      `<section data-tab="t">
        <span data-distance="a" data-breaks="500 1000"></span>
        <span data-distance="b" data-breaks="500 1000"></span>
        <span data-distance="c" data-breaks="500 1000"></span>
        <span data-distance="d" data-breaks="500 1000"></span>
      </section>`,
      { a: 499, b: 500, c: 1430 },
    );
    const cells = Array.from(fragment(r.tabs[0].html).querySelectorAll("span"));
    expect(cells.map((c) => c.textContent)).toEqual(["499 meter", "500 meter", "1.430 meter", "–"]);
    expect(cells.map((c) => c.className)).toEqual([
      "text-green-600",
      "text-orange-600",
      "text-red-600",
      "text-gray-400",
    ]);
  });

  it("draws a sparkline over the years present, labelled with first and last value", () => {
    const r = renderLocationInfo(
      `<section data-tab="t"><div data-sparkline="aandeel_{year}" data-years="2026-2029" data-label="0-17 jaar"></div></section>`,
      { aandeel_2026: 18, aandeel_2027: 17.5, aandeel_2029: 16 },
    );
    const card = fragment(r.tabs[0].html);
    const points = card.querySelector("polyline")!.getAttribute("points")!.split(" ");
    expect(points).toHaveLength(3);
    expect(card.querySelector("svg")!.getAttribute("aria-label")).toBe("0-17 jaar: van 18% in 2026 naar 16% in 2029");
    expect(Array.from(card.querySelectorAll("span")).map((s) => s.textContent)).toContain("16%");
  });

  it("shows a dash instead of a line with fewer than two years", () => {
    const r = renderLocationInfo(
      `<section data-tab="t"><div data-sparkline="x_{year}" data-years="2026-2040"></div></section>`,
      { x_2026: 5 },
    );
    expect(fragment(r.tabs[0].html).querySelector("svg")).toBeNull();
    expect(r.tabs[0].html).toContain("–");
  });
});
