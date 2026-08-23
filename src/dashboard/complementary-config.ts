/**
 * The in-map comparison, loaded from `public/dashboard_complementary.json`.
 *
 * The file names layers rather than describing them: a selection layer has to
 * exist in `layers.json` with `highlightable` + `compareSelectable`, because
 * `promoteId` is fixed when the source is created and cannot be turned on for a
 * layer afterwards. This config only decides which layer is clicked at which
 * zoom, and what the panel shows.
 */
import type { DashboardWidget } from "@/dashboard/layout-config";
import { buildLayout } from "@/dashboard/layout-config";
import { loadConfig } from "@/config/load-config";

const FILE = "dashboard_complementary.json";

/** One administrative level, selected from its `minzoom` up to the next one's. */
export interface ComplementaryLevel {
  /** `layers.json` id of the selection layer. */
  layer: string;
  /** Column the comparison filters on, e.g. `"bu_code"`. */
  code: string;
  /** Lowest zoom at which this level is the one being clicked. */
  minzoom: number;
}

export interface ComplementaryConfig {
  /** Levels in ascending `minzoom` order; empty disables the comparison. */
  levels: ComplementaryLevel[];
  /** Widgets rendered per selected area, side by side. */
  widgets: DashboardWidget[];
}


function emptyConfig(): ComplementaryConfig {
  return { levels: [], widgets: [] };
}

function validateLevel(raw: unknown): ComplementaryLevel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.layer !== "string" || obj.layer === "") return null;
  if (typeof obj.code !== "string" || obj.code === "") return null;
  const minzoom = Number(obj.minzoom ?? 0);
  if (!Number.isFinite(minzoom) || minzoom < 0 || minzoom > 24) return null;
  return { layer: obj.layer, code: obj.code, minzoom };
}

/** Build from already-parsed JSON. Exported for tests. */
export function buildComplementaryConfig(data: unknown): ComplementaryConfig {
  if (typeof data !== "object" || data === null) {
    console.warn(`${FILE}: expected an object; comparison unavailable`);
    return emptyConfig();
  }
  const obj = data as Record<string, unknown>;
  const config = emptyConfig();

  if (Array.isArray(obj.levels)) {
    for (const raw of obj.levels) {
      const level = validateLevel(raw);
      if (!level) {
        console.warn(`${FILE}: dropping invalid level ${JSON.stringify(raw)}`);
        continue;
      }
      config.levels.push(level);
    }
    // Sorted so the lookup can take the last level the zoom has reached,
    // whatever order the file lists them in.
    config.levels.sort((a, b) => a.minzoom - b.minzoom);
  } else if (obj.levels !== undefined) {
    console.warn(`${FILE}: "levels" is not an array; comparison unavailable`);
  }

  // The widget list is the same shape as a dashboard layout's, so it is parsed
  // by the same validator rather than a second copy of those rules.
  config.widgets = buildLayout({ widgets: obj.widgets ?? [] }, FILE).widgets;

  return config;
}

/** Load the comparison config. Never throws; a bad file yields no levels. */
export async function loadComplementaryConfig(): Promise<ComplementaryConfig> {
  return loadConfig({
    name: FILE,
    onError: emptyConfig,
    parse: buildComplementaryConfig,
  });
}

/**
 * The level a click at this zoom belongs to: the last one whose `minzoom` the
 * map has reached. `null` below the coarsest level, which is how a project
 * keeps the comparison off until the user has zoomed in far enough to aim.
 */
export function levelForZoom(
  config: ComplementaryConfig,
  zoom: number,
): ComplementaryLevel | null {
  let found: ComplementaryLevel | null = null;
  for (const level of config.levels) {
    if (zoom >= level.minzoom) found = level;
  }
  return found;
}
