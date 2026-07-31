import type { CSSProperties } from "react";
import type { SwatchSpec } from "@/lib/legend-style";

/** The neutral hairline used when the map draws no outline of its own (gray-300). */
const NEUTRAL_OUTLINE = "#d1d5db";

/**
 * A legend swatch that mirrors the symbolizer kind: filled square (Fill),
 * horizontal bar (Line), map-sized dot (Mark), or the actual tinted SVG (Icon).
 * Shared by the on-map Legend and the share-dialog preview mini-legend; the
 * PNG-export canvas draws the same shapes in map-capture.ts.
 *
 * `hidden` renders the hollow state (interior cleared, shape kept) used by the
 * legend's visibility toggles.
 */
export function Swatch({
  spec,
  size,
  hidden = false,
}: {
  spec: SwatchSpec;
  /** Square box edge in px (10 for rule rows / share preview, 12 for layer rows). */
  size: number;
  hidden?: boolean;
}) {
  const box: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };

  switch (spec.kind) {
    case "line": {
      const barHeight = Math.min(Math.max(spec.width, 1), 4);
      return (
        <span aria-hidden style={box}>
          <span
            style={{
              width: "100%",
              height: barHeight,
              backgroundColor: hidden ? "transparent" : spec.color,
              // Hollow state: a transparent bar is invisible, so keep a
              // hairline so the row still shows a toggle target.
              border: hidden ? `1px solid ${NEUTRAL_OUTLINE}` : undefined,
            }}
          />
        </span>
      );
    }
    case "circle": {
      // Sized from the MAP radius, not the box: classes that differ only by
      // radius (e.g. clusters van indicaties 6/8/12) must stay distinguishable
      // in the legend. The circle may overflow the fixed box — the box keeps
      // label alignment while the dot shows its relative size, capped at 18px
      // so it stays inside the ~20px row.
      const diameter = Math.min(Math.max(2 * spec.radius, 5), 18);
      return (
        <span aria-hidden style={box}>
          <span
            style={{
              width: diameter,
              height: diameter,
              // The box is narrower than a large circle; without this the flex
              // container squeezes the width and the dot becomes an oval.
              flexShrink: 0,
              borderRadius: "9999px",
              backgroundColor: hidden ? "transparent" : spec.color,
              border: spec.strokeColor
                ? `${Math.min(spec.strokeWidth ?? 1, 2)}px solid ${spec.strokeColor}`
                : `1px solid ${NEUTRAL_OUTLINE}`,
            }}
          />
        </span>
      );
    }
    case "icon": {
      if (hidden) {
        // Shape without color: keep the silhouette footprint as a hollow box.
        return (
          <span aria-hidden style={{ ...box, border: `1px solid ${NEUTRAL_OUTLINE}` }} />
        );
      }
      if (spec.tint) {
        // CSS mask = the legend equivalent of the map's SDF tinting: the SVG's
        // opaque shape is kept, recolored with the symbolizer tint.
        const mask: CSSProperties = {
          width: size,
          height: size,
          backgroundColor: spec.tint,
          maskImage: `url("${spec.url}")`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskImage: `url("${spec.url}")`,
          WebkitMaskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
        };
        return (
          <span aria-hidden style={box}>
            <span style={mask} />
          </span>
        );
      }
      return (
        <span aria-hidden style={box}>
          <img src={spec.url} alt="" width={size} height={size} style={{ objectFit: "contain" }} />
        </span>
      );
    }
    case "fill":
    default:
      return (
        <span
          aria-hidden
          style={{
            ...box,
            backgroundColor: hidden ? "transparent" : spec.color,
            border: `1px solid ${spec.outline ?? NEUTRAL_OUTLINE}`,
          }}
        />
      );
  }
}
