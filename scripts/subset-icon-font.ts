import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import subsetFont from "subset-font";

/**
 * Build-time subsetting of the Material Symbols (Outlined) icon font.
 *
 * The `material-symbols` package ships the ENTIRE outlined face (~3.9 MB woff2,
 * ~3500 glyphs) but the app renders at most a few dozen icons — by ligature,
 * e.g. the text "search" maps to the search glyph. This plugin gathers every
 * icon name the app can render and subsets the emitted woff2 down to just those
 * glyphs (typically ~15–25 KB), keeping the ligature substitution so names
 * still resolve.
 *
 * Icon names come from two places, both scanned so the subset is a safe
 * superset for every bundled config (not just the active VITE_CONFIG_PROJECT):
 *   - literal `name="…"` props in src/ (the toolbar, legend, etc.)
 *   - `"icon": "…"` values in configs/ and public/ (navigation/charts/map JSON)
 * `.svg` names are local SVG assets, not font glyphs — excluded.
 *
 * The subset replaces the already-emitted hashed woff2 asset in-place during
 * generateBundle, so the CSS url() (same hashed name) needs no rewriting.
 */

const ICON_NAME_RE = /^[a-z0-9_]+$/;

/** Literal Icon name props in source: name="x" or name={"x"}. */
function iconNamesFromSource(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        const src = fs.readFileSync(p, "utf8");
        for (const m of src.matchAll(/name=\{?"([a-zA-Z0-9_]+)"/g)) out.add(m[1]);
      }
    }
  };
  walk(path.join(root, "src"));
  return out;
}

/** `"icon": "x"` values across every config dir + public/. */
function iconNamesFromConfigs(root: string): Set<string> {
  const out = new Set<string>();
  const dirs = [path.join(root, "configs"), path.join(root, "public")];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".json")) {
        const src = fs.readFileSync(p, "utf8");
        for (const m of src.matchAll(/"icon"\s*:\s*"([^"]+)"/g)) out.add(m[1]);
      }
    }
  };
  dirs.forEach(walk);
  return out;
}

/** The union of used names that are Material Symbols glyphs (not .svg assets). */
export function collectIconNames(root: string): string[] {
  const names = new Set<string>([
    ...iconNamesFromSource(root),
    ...iconNamesFromConfigs(root),
  ]);
  // `circle` is the runtime fallback in nav-icon.tsx (name || "circle").
  names.add("circle");
  return [...names].filter((n) => ICON_NAME_RE.test(n)).sort();
}

export function subsetIconFont(root = process.cwd()): Plugin {
  let disabled = false;
  let names: string[] = [];

  return {
    name: "subset-icon-font",
    apply: "build",
    configResolved() {
      names = collectIconNames(root);
      // The ligature text the font needs: each icon name, space-joined. Spaces
      // are harmless (no glyph) and separate the ligature lookups.
      if (names.length === 0) {
        disabled = true;
        this.warn?.("subset-icon-font: no icon names found; skipping subset");
      }
    },
    async generateBundle(_options, bundle) {
      if (disabled) return;
      const key = Object.keys(bundle).find(
        (k) => /material-symbols-outlined.*\.woff2$/.test(k),
      );
      if (!key) {
        this.warn(
          "subset-icon-font: material-symbols woff2 not found in bundle; font left unsubset",
        );
        return;
      }
      const asset = bundle[key];
      if (asset.type !== "asset" || !(asset.source instanceof Uint8Array)) {
        this.warn(`subset-icon-font: ${key} is not a binary asset; skipped`);
        return;
      }

      const before = asset.source.byteLength;
      const text = names.join(" ");
      const subset = await subsetFont(Buffer.from(asset.source), text, {
        targetFormat: "woff2",
        // Material Symbols is a variable font (FILL/wght/GRAD/opsz). The app
        // renders a single static style — weight 400, unfilled — so pin every
        // axis to that instance. Without this the retained per-glyph variation
        // data keeps the file at multi-MB even after glyph subsetting; pinning
        // collapses it to ~20 KB. Ligature features are retained by default so
        // icon-name text still resolves to the glyph.
        variationAxes: { wght: 400, FILL: 0, GRAD: 0, opsz: 24 },
      });
      asset.source = new Uint8Array(subset);

      const after = subset.byteLength;
      this.info?.(
        `subset-icon-font: ${key} ${(before / 1e6).toFixed(2)}MB → ${(
          after / 1024
        ).toFixed(1)}KB (${names.length} icons)`,
      );
    },
  };
}
