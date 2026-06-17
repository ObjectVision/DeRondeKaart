import { cn } from "@/lib/utils";

/**
 * Renders a Google Material Symbols (Outlined) icon by its symbol name, e.g.
 * "groups", "home", "chevron_right". The name is the literal icon name from
 * fonts.google.com/icons — no mapping table. The font is loaded once via
 * `material-symbols/outlined.css` (imported in index.css).
 *
 * Material Symbols are a font: the glyph is sized by `font-size`, so pass a
 * pixel `size` rather than a Tailwind size-* class. `color` falls back to the
 * current text color.
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
