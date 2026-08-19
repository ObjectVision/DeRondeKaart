/**
 * The in-map comparison, loaded from `public/dashboard_complementary.json`.
 *
 * The file names layers rather than describing them: a selection layer has to
 * exist in `layers.json` with `highlightable` + `compareSelectable`, because
 * `promoteId` is fixed when the source is created and cannot be turned on for a
 * layer afterwards. This config only decides which of those layers is used at
 * which zoom, and what the panel shows.
 */
import type { DashboardWidget } from "@/dashboard/layout-config";
import { buildLayout } from "@/dashboard/layout-config";

const FILE = "dashboard_complementary.json";

export interface ComplementaryConfig {
  /** Layer clicked below {@link buurtZoom} — the coarser level. */
  gemeenteLayer?: string;
  /** Layer clicked at or above {@link buurtZoom}. */
  buurtLayer?: string;
  /**
   * Zoom at which selection switches from the coarse to the fine layer, so a
   * user can pick a gemeente, zoom in and add buurten to the same comparison.
   */
  buurtZoom: number;
  /** Column the comparison queries on per level. */
  gemeenteCode: string;
  buurtCode: string;
  /** Widgets rendered per selected area, side by side. */
  widgets: DashboardWidget[];
}

const DEFAULT_BUURT_ZOOM = 12;

let cached: ComplementaryConfig | null = null;

function emptyConfig(): ComplementaryConfig {
  return {
    buurtZoom: DEFAULT_BUURT_ZOOM,
    gemeenteCode: "gm_code",
    buurtCode: "bu_code",
    widgets: [],
  };
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** Build from already-parsed JSON. Exported for tests. */
export function buildComplementaryConfig(data: unknown): ComplementaryConfig {
  if (typeof data !== "object" || data === null) {
    console.warn(`${FILE}: expected an object; comparison unavailable`);
    return emptyConfig();
  }
  const obj = data as Record<string, unknown>;
  const config = emptyConfig();

  config.gemeenteLayer = optionalString(obj.gemeenteLayer);
  config.buurtLayer = optionalString(obj.buurtLayer);
  config.gemeenteCode = optionalString(obj.gemeenteCode) ?? config.gemeenteCode;
  config.buurtCode = optionalString(obj.buurtCode) ?? config.buurtCode;

  const zoom = Number(obj.buurtZoom);
  if (obj.buurtZoom !== undefined) {
    if (Number.isFinite(zoom) && zoom >= 0 && zoom <= 24) {
      config.buurtZoom = zoom;
    } else {
      console.warn(
        `${FILE}: invalid "buurtZoom" ${JSON.stringify(obj.buurtZoom)}; using ${DEFAULT_BUURT_ZOOM}`,
      );
    }
  }

  // The widget list is the same shape as a dashboard layout's, so it is parsed
  // by the same validator rather than a second copy of those rules.
  config.widgets = buildLayout({ widgets: obj.widgets ?? [] }, FILE).widgets;

  return config;
}

/** Load the comparison config. Never throws; a bad file yields no widgets. */
export async function loadComplementaryConfig(): Promise<ComplementaryConfig> {
  if (cached) return cached;

  let data: unknown;
  try {
    const response = await fetch(`/${FILE}`);
    if (!response.ok) {
      console.warn(`${FILE}: failed to load (${response.statusText}); comparison unavailable`);
      return (cached = emptyConfig());
    }
    data = await response.json();
  } catch (err) {
    console.warn(`${FILE}: not found or invalid JSON; comparison unavailable`, err);
    return (cached = emptyConfig());
  }

  cached = buildComplementaryConfig(data);
  return cached;
}

/**
 * Which selection layer a click at this zoom belongs to, and which code column
 * the comparison then filters on. `null` when the config names no layer for
 * that level, which is how a project offers only one of the two.
 */
export function levelForZoom(
  config: ComplementaryConfig,
  zoom: number,
): { layerId: string; codeColumn: string } | null {
  const fine = zoom >= config.buurtZoom;
  const layerId = fine ? config.buurtLayer : config.gemeenteLayer;
  if (!layerId) return null;
  return { layerId, codeColumn: fine ? config.buurtCode : config.gemeenteCode };
}
