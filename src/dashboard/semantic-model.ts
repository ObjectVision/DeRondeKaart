/**
 * The dashboard's data model, loaded from `public/dashboard_semantic_model.json`.
 *
 * Tables carry their own parquet URLs rather than pointing into `layers.json`:
 * the standalone dashboard must work in a project that configures no map layers
 * at all, and a measure is not a map layer even when both read the same file.
 *
 * Loading mirrors `src/layers/charts.ts`: module-level cache, never throws, and
 * invalid entries are dropped with a warning rather than failing the page.
 */
import type { ChartValueFormat } from "@/layers/types";

/** How a measure collapses many rows into one number. */
export type MeasureAggregation = "sum" | "mean" | "count" | "min" | "max";

/** A column's part in the model: something to aggregate, or something to group by. */
export type ColumnRole = "measure" | "dimension";

export interface ModelColumn {
  name: string;
  role: ColumnRole;
  label: string;
  format?: ChartValueFormat;
}

export interface ModelTable {
  name: string;
  /** Parquet URL, read by DuckDB over HTTP range requests. */
  url: string;
  /** Column that identifies a row — a CBS code for the area tables. */
  key: string;
  columns: ModelColumn[];
}

/**
 * A join between two tables, written as `"<table>.<column>"` on both sides.
 * Undirected: the query builder walks relationships in either direction.
 */
export interface ModelRelationship {
  from: string;
  to: string;
}

export interface ModelMeasure {
  id: string;
  table: string;
  /**
   * SQL fragment over that table's columns. Authored in the deployment's own
   * config file and inserted as written — see the trust note on
   * {@link loadSemanticModel}.
   */
  expression: string;
  aggregation: MeasureAggregation;
  label: string;
  format: ChartValueFormat;
}

export interface ModelDimension {
  id: string;
  table: string;
  column: string;
  label: string;
}

export interface SemanticModel {
  tables: Map<string, ModelTable>;
  relationships: ModelRelationship[];
  measures: Map<string, ModelMeasure>;
  dimensions: Map<string, ModelDimension>;
}

const AGGREGATIONS: MeasureAggregation[] = ["sum", "mean", "count", "min", "max"];
const FORMATS: ChartValueFormat[] = ["number", "percent", "currency"];
const COLUMN_ROLES: ColumnRole[] = ["measure", "dimension"];

let cachedModel: SemanticModel | null = null;

/** An empty model — what every failure path returns. */
function emptyModel(): SemanticModel {
  return {
    tables: new Map(),
    relationships: [],
    measures: new Map(),
    dimensions: new Map(),
  };
}

function validateColumn(raw: unknown): ModelColumn | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name === "") return null;
  if (!COLUMN_ROLES.includes(obj.role as ColumnRole)) return null;
  if (typeof obj.label !== "string" || obj.label === "") return null;
  return {
    name: obj.name,
    role: obj.role as ColumnRole,
    label: obj.label,
    format: FORMATS.includes(obj.format as ChartValueFormat)
      ? (obj.format as ChartValueFormat)
      : undefined,
  };
}

function validateTable(raw: unknown): ModelTable | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name === "") return null;
  if (typeof obj.url !== "string" || obj.url === "") return null;
  if (typeof obj.key !== "string" || obj.key === "") return null;

  const columns: ModelColumn[] = [];
  if (Array.isArray(obj.columns)) {
    for (const rawColumn of obj.columns) {
      const column = validateColumn(rawColumn);
      if (!column) {
        console.warn(
          `dashboard_semantic_model.json: dropping invalid column ${JSON.stringify(rawColumn)} of table "${obj.name}"`,
        );
        continue;
      }
      columns.push(column);
    }
  }

  return { name: obj.name, url: obj.url, key: obj.key, columns };
}

/** Split `"table.column"`, rejecting anything that is not exactly two parts. */
function splitRef(ref: unknown): [string, string] | null {
  if (typeof ref !== "string") return null;
  const parts = ref.split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return [parts[0], parts[1]];
}

function validateRelationship(raw: unknown): ModelRelationship | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!splitRef(obj.from) || !splitRef(obj.to)) return null;
  return { from: obj.from as string, to: obj.to as string };
}

function validateMeasure(raw: unknown): ModelMeasure | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") return null;
  if (typeof obj.table !== "string" || obj.table === "") return null;
  if (typeof obj.expression !== "string" || obj.expression === "") return null;
  if (typeof obj.label !== "string" || obj.label === "") return null;

  return {
    id: obj.id,
    table: obj.table,
    expression: obj.expression,
    label: obj.label,
    // Lenient where charts.json is lenient: an unrecognised aggregation or
    // format is a typo in one field, not a reason to lose the measure.
    aggregation: AGGREGATIONS.includes(obj.aggregation as MeasureAggregation)
      ? (obj.aggregation as MeasureAggregation)
      : "sum",
    format: FORMATS.includes(obj.format as ChartValueFormat)
      ? (obj.format as ChartValueFormat)
      : "number",
  };
}

function validateDimension(raw: unknown): ModelDimension | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") return null;
  if (typeof obj.table !== "string" || obj.table === "") return null;
  if (typeof obj.column !== "string" || obj.column === "") return null;
  if (typeof obj.label !== "string" || obj.label === "") return null;
  return { id: obj.id, table: obj.table, column: obj.column, label: obj.label };
}

/**
 * Build a model from already-parsed JSON. Exported for tests and for the
 * postMessage `dashboard-reload` path, which re-points table URLs without
 * re-fetching the file.
 *
 * Entries naming a table the model does not define are dropped here rather than
 * at query time: a measure with no table can never answer, and finding that out
 * while the page loads gives a warning that names the culprit.
 */
export function buildSemanticModel(data: unknown): SemanticModel {
  const model = emptyModel();
  if (typeof data !== "object" || data === null) {
    console.warn("dashboard_semantic_model.json: expected an object; no model available");
    return model;
  }
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.tables)) {
    for (const raw of obj.tables) {
      const table = validateTable(raw);
      if (!table) {
        console.warn(`dashboard_semantic_model.json: dropping invalid table ${JSON.stringify(raw)}`);
        continue;
      }
      if (model.tables.has(table.name)) {
        console.warn(
          `dashboard_semantic_model.json: duplicate table "${table.name}"; keeping the first`,
        );
        continue;
      }
      model.tables.set(table.name, table);
    }
  }

  if (Array.isArray(obj.relationships)) {
    for (const raw of obj.relationships) {
      const relationship = validateRelationship(raw);
      if (!relationship) {
        console.warn(
          `dashboard_semantic_model.json: dropping invalid relationship ${JSON.stringify(raw)}`,
        );
        continue;
      }
      const fromTable = splitRef(relationship.from)![0];
      const toTable = splitRef(relationship.to)![0];
      if (!model.tables.has(fromTable) || !model.tables.has(toTable)) {
        console.warn(
          `dashboard_semantic_model.json: relationship "${relationship.from}" -> "${relationship.to}" names an unknown table; dropping`,
        );
        continue;
      }
      model.relationships.push(relationship);
    }
  }

  if (Array.isArray(obj.measures)) {
    for (const raw of obj.measures) {
      const measure = validateMeasure(raw);
      if (!measure) {
        console.warn(
          `dashboard_semantic_model.json: dropping invalid measure ${JSON.stringify(raw)}`,
        );
        continue;
      }
      if (!model.tables.has(measure.table)) {
        console.warn(
          `dashboard_semantic_model.json: measure "${measure.id}" names unknown table "${measure.table}"; dropping`,
        );
        continue;
      }
      if (model.measures.has(measure.id)) {
        console.warn(
          `dashboard_semantic_model.json: duplicate measure id "${measure.id}"; keeping the first`,
        );
        continue;
      }
      model.measures.set(measure.id, measure);
    }
  }

  if (Array.isArray(obj.dimensions)) {
    for (const raw of obj.dimensions) {
      const dimension = validateDimension(raw);
      if (!dimension) {
        console.warn(
          `dashboard_semantic_model.json: dropping invalid dimension ${JSON.stringify(raw)}`,
        );
        continue;
      }
      if (!model.tables.has(dimension.table)) {
        console.warn(
          `dashboard_semantic_model.json: dimension "${dimension.id}" names unknown table "${dimension.table}"; dropping`,
        );
        continue;
      }
      if (model.dimensions.has(dimension.id)) {
        console.warn(
          `dashboard_semantic_model.json: duplicate dimension id "${dimension.id}"; keeping the first`,
        );
        continue;
      }
      model.dimensions.set(dimension.id, dimension);
    }
  }

  return model;
}

/**
 * Load `public/dashboard_semantic_model.json`. Never throws: a missing or
 * invalid file yields an empty model, and the dashboard then renders its
 * widgets as unavailable rather than a blank page.
 *
 * Trust note: `expression` reaches the SQL string as authored. The file ships
 * with the deployment, so it is trusted input in the same way `layers.json` is —
 * there is no user-supplied path into it, and escaping it would only break
 * legitimate SQL.
 */
export async function loadSemanticModel(): Promise<SemanticModel> {
  if (cachedModel) return cachedModel;

  let data: unknown;
  try {
    const response = await fetch("/dashboard_semantic_model.json");
    if (!response.ok) {
      console.warn(
        `dashboard_semantic_model.json: failed to load (${response.statusText}); no model available`,
      );
      return (cachedModel = emptyModel());
    }
    data = await response.json();
  } catch (err) {
    console.warn(
      "dashboard_semantic_model.json: not found or invalid JSON; no model available",
      err,
    );
    return (cachedModel = emptyModel());
  }

  cachedModel = buildSemanticModel(data);
  return cachedModel;
}

/**
 * Replace the URLs of named tables, for the host's `dashboard-reload` message.
 * Returns a new model; the cache is updated so later loaders see the same one.
 */
export function withTableUrls(
  model: SemanticModel,
  urls: Record<string, string>,
): SemanticModel {
  const tables = new Map(model.tables);
  for (const [name, url] of Object.entries(urls)) {
    const table = tables.get(name);
    if (!table) {
      console.warn(`dashboard-reload: unknown table "${name}"; ignoring`);
      continue;
    }
    tables.set(name, { ...table, url });
  }
  const next = { ...model, tables };
  cachedModel = next;
  return next;
}
