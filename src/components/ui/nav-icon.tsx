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
 * Pass a pixel `size` rather than a Tailwind size-* class either way.
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
        width={size}
        height={size}
        className={cn("inline-block select-none", className)}
        style={{ width: size, height: size }}
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
 * navigation.json. Falls back to a neutral dot when no icon is set.
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
  return <Icon name={name || "circle"} size={size} color={color} className={className} />;
}
