/**
 * Dashboard layouts, loaded from `public/dashboard_standalone.json` and
 * `public/dashboard_export.json`.
 *
 * Both files describe the same widget grid; the export file only overrides it
 * for print, so one set of types and one loader serve both. Same stance as
 * `src/layers/charts.ts`: module-level cache, never throws, invalid widgets
 * dropped with a warning.
 */

/** What a widget renders. */
export type WidgetKind = "chart" | "statistic" | "text";

export interface DashboardWidget {
  kind: WidgetKind;
  /**
   * `chart` — a `charts.json` chart id.
   * `statistic` — a semantic-model measure id.
   * `text` — unused.
   */
  ref?: string;
  /** Optional heading; a `text` widget uses `body` for its content. */
  title?: string;
  body?: string;
  /** Semantic-model dimension id a chart groups by. Ignored by the other kinds. */
  dimension?: string;
  /**
   * Semantic-model measure ids a `chart` plots. Absent means "the ids listed as
   * `data.fields[].field` on the referenced chart" — a chart authored against
   * columns reads as one authored against measures, since in the dashboard's
   * world those names are measure ids.
   *
   * A `statistic` widget takes its single measure from `ref` instead.
   */
  measures?: string[];
  /** Grid columns this widget spans, 1-4. Defaults to 1. */
  span?: number;
}

export interface DashboardLayout {
  title?: string;
  subtitle?: string;
  /** Grid columns at desktop width, 1-4. Defaults to 2. */
  columns: number;
  widgets: DashboardWidget[];
}

/** Page setup for the print/PDF layout. */
export interface DashboardExportLayout extends DashboardLayout {
  pageSize: "A4" | "A3" | "letter";
  orientation: "portrait" | "landscape";
}

const WIDGET_KINDS: WidgetKind[] = ["chart", "statistic", "text"];
const PAGE_SIZES: DashboardExportLayout["pageSize"][] = ["A4", "A3", "letter"];
const ORIENTATIONS: DashboardExportLayout["orientation"][] = ["portrait", "landscape"];

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 4;
const DEFAULT_COLUMNS = 2;

let cachedStandalone: DashboardLayout | null = null;
let cachedExport: DashboardExportLayout | null = null;

function emptyLayout(): DashboardLayout {
  return { columns: DEFAULT_COLUMNS, widgets: [] };
}

/** Clamp a grid count into 1..4, falling back when it is not a usable number. */
function validateColumns(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_COLUMNS || value > MAX_COLUMNS) {
    console.warn(`dashboard layout: invalid "${key}" ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return value;
}

function validateWidget(raw: unknown): DashboardWidget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!WIDGET_KINDS.includes(obj.kind as WidgetKind)) return null;
  const kind = obj.kind as WidgetKind;

  const ref = typeof obj.ref === "string" && obj.ref !== "" ? obj.ref : undefined;
  const body = typeof obj.body === "string" ? obj.body : undefined;
  // A chart or statistic without a ref has nothing to resolve against; a text
  // block without a body would render an empty card.
  if (kind === "text" ? body === undefined : ref === undefined) return null;

  const measures = Array.isArray(obj.measures)
    ? obj.measures.filter((id): id is string => typeof id === "string" && id !== "")
    : undefined;

  return {
    kind,
    ref,
    body,
    title: typeof obj.title === "string" && obj.title !== "" ? obj.title : undefined,
    dimension:
      typeof obj.dimension === "string" && obj.dimension !== "" ? obj.dimension : undefined,
    measures: measures && measures.length > 0 ? measures : undefined,
    span: validateColumns(obj.span, "span", 1),
  };
}

/** Build a layout from already-parsed JSON. Exported for tests. */
export function buildLayout(data: unknown, file: string): DashboardLayout {
  if (typeof data !== "object" || data === null) {
    console.warn(`${file}: expected an object; no layout available`);
    return emptyLayout();
  }
  const obj = data as Record<string, unknown>;

  const widgets: DashboardWidget[] = [];
  if (Array.isArray(obj.widgets)) {
    for (const raw of obj.widgets) {
      const widget = validateWidget(raw);
      if (!widget) {
        console.warn(`${file}: dropping invalid widget ${JSON.stringify(raw)}`);
        continue;
      }
      widgets.push(widget);
    }
  } else {
    console.warn(`${file}: expected { "widgets": [...] }; no widgets available`);
  }

  return {
    title: typeof obj.title === "string" && obj.title !== "" ? obj.title : undefined,
    subtitle: typeof obj.subtitle === "string" && obj.subtitle !== "" ? obj.subtitle : undefined,
    columns: validateColumns(obj.columns, "columns", DEFAULT_COLUMNS),
    widgets,
  };
}

/** Fetch and parse one layout file, or `null` when it is absent/unreadable. */
async function fetchLayout(file: string): Promise<unknown | null> {
  try {
    const response = await fetch(`/${file}`);
    if (!response.ok) {
      console.warn(`${file}: failed to load (${response.statusText})`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(`${file}: not found or invalid JSON`, err);
    return null;
  }
}

/** Load the standalone layout. Never throws; a bad file yields no widgets. */
export async function loadStandaloneLayout(): Promise<DashboardLayout> {
  if (cachedStandalone) return cachedStandalone;
  const data = await fetchLayout("dashboard_standalone.json");
  cachedStandalone = data === null ? emptyLayout() : buildLayout(data, "dashboard_standalone.json");
  return cachedStandalone;
}

/**
 * Load the print layout, falling back to the standalone one when the file is
 * absent or defines no widgets — a project that is happy printing what it shows
 * should not have to restate it.
 */
export async function loadExportLayout(): Promise<DashboardExportLayout> {
  if (cachedExport) return cachedExport;

  const data = await fetchLayout("dashboard_export.json");
  const obj = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const parsed = data === null ? emptyLayout() : buildLayout(data, "dashboard_export.json");
  const base = parsed.widgets.length > 0 ? parsed : await loadStandaloneLayout();

  cachedExport = {
    ...base,
    title: parsed.title ?? base.title,
    subtitle: parsed.subtitle ?? base.subtitle,
    pageSize: PAGE_SIZES.includes(obj.pageSize as DashboardExportLayout["pageSize"])
      ? (obj.pageSize as DashboardExportLayout["pageSize"])
      : "A4",
    orientation: ORIENTATIONS.includes(obj.orientation as DashboardExportLayout["orientation"])
      ? (obj.orientation as DashboardExportLayout["orientation"])
      : "portrait",
  };
  return cachedExport;
}
