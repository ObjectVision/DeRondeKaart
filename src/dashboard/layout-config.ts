/**
 * Dashboard layouts, loaded from `public/dashboard_standalone.json` and
 * `public/dashboard_export.json`.
 *
 * Both files describe the same widget grid; the export file only overrides it
 * for print, so one set of types and one loader serve both. Same stance as
 * `src/layers/charts.ts`: module-level cache, never throws, invalid widgets
 * dropped with a warning.
 */

import { loadConfig } from "@/config/load-config";

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

const STANDALONE_FILE = "dashboard_standalone.json";
const EXPORT_FILE = "dashboard_export.json";

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 4;
const DEFAULT_COLUMNS = 2;

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


/** Load the standalone layout. Never throws; a bad file yields no widgets. */
export async function loadStandaloneLayout(): Promise<DashboardLayout> {
  return loadConfig({
    name: STANDALONE_FILE,
    onError: emptyLayout,
    parse: (data) => buildLayout(data, STANDALONE_FILE),
  });
}

/**
 * Load the print layout, falling back to the standalone one when the file is
 * absent or defines no widgets — a project that is happy printing what it shows
 * should not have to restate it.
 */
export async function loadExportLayout(): Promise<DashboardExportLayout> {
  // Parsed separately from the fallback below: a file that exists but defines no
  // widgets still contributes its title/pageSize/orientation.
  const parsed = await loadConfig({
    name: EXPORT_FILE,
    onError: () => ({ layout: emptyLayout(), obj: {} as Record<string, unknown> }),
    parse: (data) => ({
      layout: buildLayout(data, EXPORT_FILE),
      obj: (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>,
    }),
  });

  // A project happy printing what it shows should not have to restate it.
  const base = parsed.layout.widgets.length > 0 ? parsed.layout : await loadStandaloneLayout();

  return {
    ...base,
    title: parsed.layout.title ?? base.title,
    subtitle: parsed.layout.subtitle ?? base.subtitle,
    pageSize: PAGE_SIZES.includes(parsed.obj.pageSize as DashboardExportLayout["pageSize"])
      ? (parsed.obj.pageSize as DashboardExportLayout["pageSize"])
      : "A4",
    orientation: ORIENTATIONS.includes(parsed.obj.orientation as DashboardExportLayout["orientation"])
      ? (parsed.obj.orientation as DashboardExportLayout["orientation"])
      : "portrait",
  };
}
