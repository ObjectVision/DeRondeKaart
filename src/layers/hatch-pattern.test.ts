import { describe, expect, it } from "vitest";

import {
  HATCH,
  HATCH_EQUAL_BANDS,
  hatchCSS,
  hatchPatternId,
  hatchSegments,
  resolveHatch,
} from "@/layers/hatch-pattern";

/**
 * The stripe width is per-symbolizer so one class can draw equal bands of two
 * colours without restyling every "Geen doorrekening" hatch in the app. These
 * pin both halves of that: the default is untouched, and an override reaches
 * the sprite id and the legend's CSS.
 *
 * `renderHatchTile` needs a real 2D context, so the drawn tile is left to the
 * visual check rather than a stubbed canvas.
 */
describe("resolveHatch", () => {
  it("keeps the thin red-on-white default for `hatch: true`", () => {
    expect(resolveHatch(true)).toEqual({
      color: "#E02B27",
      background: "#ffffff",
      stripe: HATCH.stripe,
    });
  });

  it("returns undefined when the symbolizer does not opt in", () => {
    expect(resolveHatch(undefined)).toBeUndefined();
    expect(resolveHatch(false)).toBeUndefined();
  });

  it("falls back per field, so a colours-only override keeps the default width", () => {
    expect(resolveHatch({ color: "#9D0064", background: "#2688AE" })).toEqual({
      color: "#9D0064",
      background: "#2688AE",
      stripe: HATCH.stripe,
    });
  });

  it("takes a stripe width", () => {
    expect(resolveHatch({ stripe: HATCH_EQUAL_BANDS })?.stripe).toBe(HATCH_EQUAL_BANDS);
  });
});

describe("hatchPatternId", () => {
  it("separates two widths of the same colour pair", () => {
    // addImage is a no-op once an id is taken, so a shared id would leave the
    // second registration silently drawing the first one's geometry.
    const thin = resolveHatch({ color: "#9D0064", background: "#2688AE" })!;
    const bands = resolveHatch({
      color: "#9D0064",
      background: "#2688AE",
      stripe: HATCH_EQUAL_BANDS,
    })!;

    expect(hatchPatternId(thin)).not.toBe(hatchPatternId(bands));
  });
});

describe("hatchCSS", () => {
  it("draws the legend swatch at the symbolizer's own stripe width", () => {
    const css = hatchCSS(
      resolveHatch({ color: "#9D0064", background: "#2688AE", stripe: 2 })!,
    );

    expect(css).toContain("#9D0064 0 2px");
    expect(css).toContain("#2688AE 2px");
  });
});

describe("HATCH_EQUAL_BANDS", () => {
  it("is half the stripe period, so the two colours cover equal area", () => {
    const period = HATCH.size / Math.SQRT2;
    expect(HATCH_EQUAL_BANDS).toBeCloseTo(period / 2, 10);
    expect(HATCH_EQUAL_BANDS).toBeCloseTo(2.83, 2);
  });
});

/**
 * The tile must contain the whole hatch, not most of it.
 *
 * Each stripe is stroked as a segment with `lineCap: "butt"`, which paints
 * nothing past its endpoints. If a segment stops on the tile's edge, every
 * pixel whose perpendicular foot falls beyond that end goes unpainted — a
 * triangle sized by half the stroke width. Invisible at the 1px default,
 * plainly visible once a class asks for equal bands, and repeated at every
 * tile.
 *
 * So this asserts the property that actually matters — no pixel the hatch
 * should cover is left out — rather than restating the endpoint arithmetic.
 * `renderHatchTile` itself needs a real 2D context, which jsdom does not
 * provide, hence testing the geometry it draws from.
 */
function pixelsMissedBy(stripe: number): number {
  const scale = 2;
  const px = HATCH.size * scale;
  const half = (stripe * scale) / 2;
  const period = HATCH.size * scale;
  const segments = hatchSegments(scale);

  // At an equal-band stripe the band edges fall exactly on pixel centres, so a
  // bare comparison would count ties as misses and report a defect that does
  // not exist. Only pixels strictly inside the band are required.
  const EPS = 1e-9;

  let missed = 0;
  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // What the ideal, unbounded hatch would paint here: perpendicular
      // distance to the nearest stripe centreline.
      const c = cx + cy;
      const nearest = Math.round(c / period) * period;
      if (Math.abs(c - nearest) / Math.SQRT2 >= half - EPS) continue;

      // What the drawn segments actually cover, butt caps respected.
      const covered = segments.some(([[ax, ay], [bx, by]]) => {
        const dx = bx - ax;
        const dy = by - ay;
        const t = ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy);
        if (t < 0 || t > 1) return false;
        return Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy)) <= half + EPS;
      });
      if (!covered) missed += 1;
    }
  }
  return missed;
}

describe("hatchSegments", () => {
  it("covers every pixel of an equal-band hatch", () => {
    expect(pixelsMissedBy(HATCH_EQUAL_BANDS)).toBe(0);
  });

  it("covers every pixel of the thin default hatch", () => {
    expect(pixelsMissedBy(HATCH.stripe)).toBe(0);
  });

  it("covers every pixel at the rounded width the LN layers carry", () => {
    // The configs spell 2.83 rather than the exact constant; that is the value
    // the notches actually appeared at.
    expect(pixelsMissedBy(2.83)).toBe(0);
  });

  it("overhangs the tile at both ends", () => {
    const scale = 2;
    const px = HATCH.size * scale;
    for (const [[ax, ay], [bx, by]] of hatchSegments(scale)) {
      // Every segment starts above the tile and ends below it, so neither cap
      // can land on a pixel the tile shows.
      expect(ay).toBeLessThan(0);
      expect(by).toBeGreaterThan(px);
      expect(Math.min(ay, by)).toBeLessThanOrEqual(-HATCH_EQUAL_BANDS * scale);
      expect(Math.max(ax, bx) - Math.min(ax, bx)).toBeGreaterThan(px);
    }
  });
});
