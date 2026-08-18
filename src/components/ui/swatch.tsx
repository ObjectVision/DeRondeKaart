import { Match, Switch, type JSX } from "solid-js";
import type { SwatchSpec } from "@/lib/legend-style";
import { hatchCSS } from "@/layers/hatch-pattern";

/** The neutral hairline used when the map draws no outline of its own (gray-300). */
const NEUTRAL_OUTLINE = "#d1d5db";

interface SwatchProps {
  spec: SwatchSpec;
  /** Square box edge in px (10 for rule rows / share preview, 12 for layer rows). */
  size: number;
  hidden?: boolean;
}

/**
 * A legend swatch that mirrors the symbolizer kind: filled square (Fill),
 * horizontal bar (Line), map-sized dot (Mark), or the actual tinted SVG (Icon).
 * Shared by the on-map Legend and the share-dialog preview mini-legend; the
 * PNG-export canvas draws the same shapes in map-capture.ts.
 *
 * `hidden` renders the hollow state (interior cleared, shape kept) used by the
 * legend's visibility toggles.
 */
export function Swatch(props: SwatchProps): JSX.Element {
  const box = (): JSX.CSSProperties => ({
    width: `${props.size}px`,
    height: `${props.size}px`,
    "flex-shrink": 0,
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
  });

  return (
    <Switch
      // Any kind the cases below don't cover renders as a bare hollow box —
      // the same footprint a fill swatch occupies, so rows stay aligned.
      fallback={<span aria-hidden style={{ ...box(), border: `1px solid ${NEUTRAL_OUTLINE}` }} />}
    >
      <Match when={props.spec.kind === "fill" ? props.spec : null}>
        {(spec) => (
          <span
            aria-hidden
            style={{
              ...box(),
              // A hatched fill draws stripes rather than a flat colour, matching
              // the map's fill-pattern. Hollow state keeps clearing the interior,
              // so the toggle still reads the same for hatched and flat classes.
              ...(spec().hatch && !props.hidden
                ? { "background-image": hatchCSS(spec().hatch!) }
                : { "background-color": props.hidden ? "transparent" : spec().color }),
              border: `1px solid ${spec().outline ?? NEUTRAL_OUTLINE}`,
            }}
          />
        )}
      </Match>

      <Match when={props.spec.kind === "line" ? props.spec : null}>
        {(spec) => (
          <span aria-hidden style={box()}>
            <span
              style={{
                width: "100%",
                height: `${Math.min(Math.max(spec().width, 1), 4)}px`,
                "background-color": props.hidden ? "transparent" : spec().color,
                // Hollow state: a transparent bar is invisible, so keep a
                // hairline so the row still shows a toggle target.
                border: props.hidden ? `1px solid ${NEUTRAL_OUTLINE}` : undefined,
              }}
            />
          </span>
        )}
      </Match>

      <Match when={props.spec.kind === "circle" ? props.spec : null}>
        {(spec) => {
          // Sized from the MAP radius, not the box: classes that differ only by
          // radius (e.g. clusters van indicaties 6/8/12) must stay distinguishable
          // in the legend. The circle may overflow the fixed box — the box keeps
          // label alignment while the dot shows its relative size, capped at 18px
          // so it stays inside the ~20px row.
          const diameter = () => Math.min(Math.max(2 * spec().radius, 5), 18);
          return (
            <span aria-hidden style={box()}>
              <span
                style={{
                  width: `${diameter()}px`,
                  height: `${diameter()}px`,
                  // The box is narrower than a large circle; without this the flex
                  // container squeezes the width and the dot becomes an oval.
                  "flex-shrink": 0,
                  "border-radius": "9999px",
                  "background-color": props.hidden ? "transparent" : spec().color,
                  border: spec().strokeColor
                    ? `${Math.min(spec().strokeWidth ?? 1, 2)}px solid ${spec().strokeColor}`
                    : `1px solid ${NEUTRAL_OUTLINE}`,
                }}
              />
            </span>
          );
        }}
      </Match>

      <Match when={props.spec.kind === "icon" ? props.spec : null}>
        {(spec) => (
          <Switch
            fallback={
              <span aria-hidden style={box()}>
                <img
                  src={spec().url}
                  alt=""
                  width={props.size}
                  height={props.size}
                  style={{ "object-fit": "contain" }}
                />
              </span>
            }
          >
            {/* Shape without color: keep the silhouette footprint as a hollow box. */}
            <Match when={props.hidden}>
              <span aria-hidden style={{ ...box(), border: `1px solid ${NEUTRAL_OUTLINE}` }} />
            </Match>
            {/* CSS mask = the legend equivalent of the map's SDF tinting: the SVG's
                opaque shape is kept, recolored with the symbolizer tint. */}
            <Match when={spec().tint}>
              <span aria-hidden style={box()}>
                <span
                  style={{
                    width: `${props.size}px`,
                    height: `${props.size}px`,
                    "background-color": spec().tint,
                    "mask-image": `url("${spec().url}")`,
                    "mask-size": "contain",
                    "mask-repeat": "no-repeat",
                    "mask-position": "center",
                    "-webkit-mask-image": `url("${spec().url}")`,
                    "-webkit-mask-size": "contain",
                    "-webkit-mask-repeat": "no-repeat",
                    "-webkit-mask-position": "center",
                  }}
                />
              </span>
            </Match>
          </Switch>
        )}
      </Match>
    </Switch>
  );
}
