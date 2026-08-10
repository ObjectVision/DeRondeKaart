import { cn } from "@/lib/utils";

/**
 * True when `name` refers to a local SVG asset in `public/icons/` rather than a
 * Material Symbols glyph name. The convention is an `.svg` suffix (a bare
 * filename like "woonzorganalyse.svg" resolves to `/icons/woonzorganalyse.svg`)
 * or an explicit path ("/icons/foo.svg", "./x.svg"). Everything else is treated
 * as a Material Symbols name.
 */
function isSvgIcon(name: string): boolean {
  return name.toLowerCase().endsWith(".svg");
}

/** Resolve an SVG icon `name` to its URL under `public/icons/`. */
function svgIconUrl(name: string): string {
  if (name.startsWith("/") || name.startsWith(".") || name.includes("://")) return name;
  return `/icons/${name}`;
}

/**
 * Renders an icon by name. Two sources, selected by the name itself:
 *
 * - A Material Symbols (Outlined) glyph name, e.g. "groups", "home",
 *   "chevron_right" — the literal icon name from fonts.google.com/icons, no
 *   mapping table. The font is loaded once via `material-symbols/outlined.css`
 *   (imported in index.css). Sized by `font-size`; `color` falls back to the
 *   current text color.
 * - A local SVG asset when the name ends in `.svg` (see `isSvgIcon`), e.g.
 *   "woonzorganalyse.svg" → `/icons/woonzorganalyse.svg`, rendered as an
 *   `<img>`. These SVGs carry their own fill color, so `color` is ignored for
 *   them (it can't retint an `<img>`).
 *
 * Pass a pixel `size` rather than a Tailwind size-* class either way. `size` is
 * the icon's **height**: a Material glyph's font-size, and an SVG's rendered
 * height with its width following the asset's aspect ratio. A square box would
 * letterbox a non-square asset — a 200x133 icon in a 24x24 box draws 24w x 16h,
 * two thirds the height of the glyphs beside it, which reads as "the icon is
 * too small" rather than "the box is the wrong shape".
 */
export function Icon({
  name,
  size = 24,
  color,
  className,
}: {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}) {
  if (isSvgIcon(name)) {
    return (
      <img
        aria-hidden
        alt=""
        src={svgIconUrl(name)}
        // Attributes are the pre-load intrinsic-size hint (square is the right
        // guess: most assets here are). The style below is what actually sizes
        // it, so a wide asset only reflows the row once, before first paint.
        width={size}
        height={size}
        className={cn("inline-block select-none", className)}
        // `maxWidth: none` overrides Tailwind preflight's `img { max-width: 100% }`,
        // which would otherwise re-clamp a wide icon inside a narrow flex row —
        // reintroducing the squashing this avoids.
        style={{ height: size, width: "auto", maxWidth: "none" }}
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("material-symbols-outlined leading-none select-none", className)}
      style={{ fontSize: size, color }}
    >
      {name}
    </span>
  );
}

/**
 * Convenience wrapper for category/leaf icons whose name + color come from
 * navigation.json.
 *
 * Renders **nothing** when no icon is configured, rather than substituting a
 * placeholder glyph: an absent `icon` in navigation.json means "no icon here",
 * and a stand-in dot reads as a real (but meaningless) icon. Returning null
 * also lets the surrounding flex `gap` collapse, so the label sits flush
 * instead of being indented by an invisible box.
 */
export function NavIcon({
  name,
  size,
  color,
  className,
}: {
  name?: string;
  size?: number;
  color?: string;
  className?: string;
}) {
  if (!name) return null;
  return <Icon name={name} size={size} color={color} className={className} />;
}
