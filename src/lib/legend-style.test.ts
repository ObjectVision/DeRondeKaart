import { describe, expect, it } from "vitest";

import { ruleSwatchSpec } from "@/lib/legend-style";
import type { GeoStylerRule } from "@/layers/types";

/**
 * Swatches for rules written as raw MapLibre paint.
 *
 * A rule may carry `type`/`paint` and no symbolizer — the supported way to
 * hand-write paint a GeoStyler symbolizer cannot express (a data-driven radius
 * ramp, a dash array). Those rules used to fall through to one neutral square,
 * so a seven-class layer showed seven identical blue swatches while the map
 * drew seven colours. The legend is a colour key; that made it a lie.
 */

const rule = (partial: Partial<GeoStylerRule>): GeoStylerRule =>
  ({ name: "test", ...partial }) as GeoStylerRule;

describe("ruleSwatchSpec with raw paint", () => {
  it("takes the circle colour and draws a circle", () => {
    const spec = ruleSwatchSpec(
      rule({ type: "circle", paint: { "circle-color": "#08519C" } }),
    );

    expect(spec).toMatchObject({ kind: "circle", color: "#08519C" });
  });

  it("takes the fill colour and draws a fill", () => {
    const spec = ruleSwatchSpec(
      rule({ type: "fill", paint: { "fill-color": "rgb(200, 0, 0)" } }),
    );

    expect(spec).toMatchObject({ kind: "fill", color: "rgb(200, 0, 0)" });
  });

  it("takes the line colour and draws a line", () => {
    const spec = ruleSwatchSpec(
      rule({ type: "line", paint: { "line-color": "rgba(255,0,0,1)" } }),
    );

    expect(spec).toMatchObject({ kind: "line", color: "rgba(255,0,0,1)" });
  });

  it("carries a literal stroke colour onto the circle", () => {
    const spec = ruleSwatchSpec(
      rule({
        type: "circle",
        paint: { "circle-color": "#08519C", "circle-stroke-color": "#fff" },
      }),
    );

    // Passed through as authored: "#fff" is already valid CSS. resolveColor
    // only rewrites the bare names ("white", "black") MapLibre accepts.
    expect(spec).toMatchObject({ strokeColor: "#fff" });
  });

  /**
   * An expression has no single colour, so reducing one to a swatch would
   * invent a value. The neutral default is the honest answer.
   */
  it("falls back to the default for an expression colour", () => {
    const spec = ruleSwatchSpec(
      rule({
        type: "circle",
        paint: {
          "circle-color": ["interpolate", ["linear"], ["get", "n"], 0, "#fff", 10, "#000"],
        },
      }),
    );

    expect(spec).toMatchObject({ kind: "circle", color: "#0080ff" });
  });

  /**
   * The radius on these rules is typically a data-driven ramp, so there is no
   * one size to show — the swatch is a colour key, not a scale.
   */
  it("uses a fixed radius rather than reading a ramp", () => {
    const spec = ruleSwatchSpec(
      rule({
        type: "circle",
        paint: {
          "circle-color": "#08519C",
          "circle-radius": ["interpolate", ["linear"], ["get", "n"], 1, 3, 2000, 24],
        },
      }),
    );

    expect(spec).toMatchObject({ kind: "circle", radius: 5 });
  });

  // A symbolizer is the richer declaration; paint alongside it is usually an
  // expression, so the declared colour stays authoritative.
  it("prefers a symbolizer's colour over a paint override", () => {
    const spec = ruleSwatchSpec(
      rule({
        symbolizers: [{ kind: "Mark", color: "#123456", radius: 4 }],
        paint: { "circle-color": "#ff0000" },
      }),
    );

    expect(spec).toMatchObject({ kind: "circle", color: "#123456" });
  });

  it("falls back to a neutral square with neither", () => {
    expect(ruleSwatchSpec(rule({}))).toMatchObject({ kind: "fill", color: "#0080ff" });
  });
});
