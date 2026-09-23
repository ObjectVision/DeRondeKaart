import { describe, expect, it } from "vitest";

import {
  HATCH,
  HATCH_EQUAL_BANDS,
  hatchCSS,
  hatchPatternId,
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
