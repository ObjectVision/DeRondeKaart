import type { JSX } from "solid-js";

interface CombinationInfoIconProps {
  /** Height and width in px, as Icon's `size`. */
  size: number;
  color?: string;
}

/**
 * The legend's info button for a combination layer: the info glyph with a
 * pencil, since that window is also where the combination is edited.
 *
 * Inline rather than a `public/icons/*.svg` through Icon: Icon draws those as an
 * `<img>`, which cannot be recoloured, and this icon takes the per-project
 * `chromeIconColor` like the glyphs beside it. Every stroke and fill is
 * `currentColor`, so `color` tints the whole mark.
 */
export function CombinationInfoIcon(props: CombinationInfoIconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      aria-hidden="true"
      class="flex-shrink-0 select-none"
      style={{ color: props.color }}
    >
      {/* Outer ring, the same weight as the info glyph. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
      {/* The i: dot and stem. */}
      <circle cx="9.5" cy="8" r="1.1" fill="currentColor" />
      <path d="M9.5 11v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      {/* Pencil, diagonal on the right. */}
      <path
        d="M13.8 15.2l4.3-4.3a1 1 0 0 0 0-1.4l-1.1-1.1a1 1 0 0 0-1.4 0l-4.3 4.3-.6 2.5 2.1-.5z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  );
}
