/**
 * Turns a widget's request — measure ids, an optional dimension, filters — into
 * one SQL statement over the semantic model's tables.
 *
 * Join paths are derived, not authored: the model declares relationships and
 * this walks them. A request whose tables cannot be connected, or can be
 * connected two different ways, is refused with a warning rather than answered
 * from an arbitrary path — a silently wrong number is worse than a missing one.
 */
import type { ModelMeasure, SemanticModel } from "@/dashboard/semantic-model";

/**
 * Restrict to CBS areas, at any level: `["GM0882"]` keeps every buurt of that
 * gemeente. Same semantics as the map's area filter — see `digitsMatch` in
 * `src/layers/area-filter.ts`, of which this is the SQL equivalent.
 */
export interface AreaFilter {
  kind: "area";
  column: string;
  codes: string[];
}

/** Restrict a column to a set of literal values. */
export interface ValueFilter {
  kind: "value";
  column: string;
  values: (string | number)[];
}

export type QueryFilter = AreaFilter | ValueFilter;

export interface QueryRequest {
  measures: string[];
  /** Semantic-model dimension id to group by. Omitted yields a single row. */
  dimension?: string;
  filters?: QueryFilter[];
  limit?: number;
}

export interface QueryPlan {
  sql: string;
  /** Measures in result-column order, so the caller can label and format them. */
  measures: ModelMeasure[];
  /** Result column holding the group label, when the request had a dimension. */
  dimensionColumn?: string;
}

/** Alias of the dimension column in the result set. */
const DIMENSION_ALIAS = "dimension";

/** SQL identifier quoting. Doubling `"` is what DuckDB expects inside `"…"`. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQL string literal quoting. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualify(table: string, column: string): string {
  return `${quoteIdent(table)}.${quoteIdent(column)}`;
}

/** Split `"table.column"` — the relationship endpoint format. */
function splitRef(ref: string): [string, string] {
  const dot = ref.indexOf(".");
  return [ref.slice(0, dot), ref.slice(dot + 1)];
}

interface JoinStep {
  table: string;
  /** `ON` clause connecting this table to one already in the FROM chain. */
  on: string;
}

/**
 * Shortest join path from `base` to every table in `wanted`.
 *
 * Breadth-first, so the first time a table is reached is by a shortest path. A
 * table reachable at the same distance through two different neighbours is
 * ambiguous: the model does not say which grain is meant, and picking one would
 * silently change the aggregate. Returns `null` in that case, and when a wanted
 * table cannot be reached at all.
 */
function planJoins(
  model: SemanticModel,
  base: string,
  wanted: Set<string>,
): JoinStep[] | null {
  const remaining = new Set([...wanted].filter((name) => name !== base));
  if (remaining.size === 0) return [];

  const distance = new Map<string, number>([[base, 0]]);
  const arrival = new Map<string, JoinStep>();
  const queue: string[] = [base];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDistance = distance.get(current)!;

    for (const relationship of model.relationships) {
      const [fromTable, fromColumn] = splitRef(relationship.from);
      const [toTable, toColumn] = splitRef(relationship.to);

      // Relationships are undirected: either endpoint may be the one we hold.
      let next: string;
      let on: string;
      if (fromTable === current) {
        next = toTable;
        on = `${qualify(fromTable, fromColumn)} = ${qualify(toTable, toColumn)}`;
      } else if (toTable === current) {
        next = fromTable;
        on = `${qualify(toTable, toColumn)} = ${qualify(fromTable, fromColumn)}`;
      } else {
        continue;
      }
      if (next === base) continue;

      const known = distance.get(next);
      if (known === undefined) {
        distance.set(next, currentDistance + 1);
        arrival.set(next, { table: next, on });
        queue.push(next);
        continue;
      }
      // Same distance through a different edge — two equally good readings.
      if (known === currentDistance + 1 && arrival.get(next)?.on !== on) {
        console.warn(
          `dashboard: ambiguous join path from "${base}" to "${next}"; widget dropped`,
        );
        return null;
      }
    }
  }

  const steps: JoinStep[] = [];
  // Sort by distance so a table is never joined before the one it joins to.
  const reachable = [...arrival.keys()].sort(
    (a, b) => distance.get(a)! - distance.get(b)!,
  );
  const needed = new Set(remaining);
  for (const table of reachable) {
    if (needed.size === 0) break;
    steps.push(arrival.get(table)!);
    needed.delete(table);
  }
  for (const table of needed) {
    console.warn(`dashboard: no join path from "${base}" to "${table}"; widget dropped`);
    return null;
  }
  // Intermediate hops are joined too, so trim nothing: `steps` is already in
  // dependency order and covers every table on the way.
  return steps;
}

/**
 * SQL for one CBS area filter.
 *
 * The codes carry a two-letter level prefix (`GM0882`, `BU08820000`), so the
 * comparison runs on the digits: a row matches when its digits and the filter's
 * digits are prefixes of one another, in either direction. That is what makes a
 * gemeente code select its buurten and a buurt code select its gemeente.
 */
function areaCondition(filter: AreaFilter): string | null {
  const column = `substr(CAST(${quoteIdent(filter.column)} AS VARCHAR), 3)`;
  const parts: string[] = [];
  for (const code of filter.codes) {
    const digits = code.replace(/^\D+/, "");
    if (digits === "") continue;
    const literal = quoteLiteral(digits);
    parts.push(`(${column} LIKE ${quoteLiteral(digits + "%")} OR ${literal} LIKE ${column} || '%')`);
  }
  if (parts.length === 0) return null;
  return `(${parts.join(" OR ")})`;
}

function valueCondition(filter: ValueFilter): string | null {
  if (filter.values.length === 0) return null;
  const literals = filter.values.map((value) =>
    typeof value === "number" ? String(value) : quoteLiteral(value),
  );
  return `${quoteIdent(filter.column)} IN (${literals.join(", ")})`;
}

/**
 * Build the statement for one request, or `null` when the model cannot answer
 * it. Every rejection warns naming the id at fault, because the caller's only
 * recourse is to render the widget as unavailable.
 *
 * A measure's `expression` is inserted as authored — `dashboard_semantic_model.json`
 * ships with the deployment and is trusted the way `layers.json` is. Identifiers
 * the builder itself emits are quoted.
 */
export function buildQuery(model: SemanticModel, request: QueryRequest): QueryPlan | null {
  const measures: ModelMeasure[] = [];
  for (const id of request.measures) {
    const measure = model.measures.get(id);
    if (!measure) {
      console.warn(`dashboard: unknown measure "${id}"; widget dropped`);
      return null;
    }
    measures.push(measure);
  }
  if (measures.length === 0) {
    console.warn("dashboard: request without measures; widget dropped");
    return null;
  }

  const dimension = request.dimension ? model.dimensions.get(request.dimension) : undefined;
  if (request.dimension && !dimension) {
    console.warn(`dashboard: unknown dimension "${request.dimension}"; widget dropped`);
    return null;
  }

  // The dimension's table is the base when there is one: grouping happens at
  // its grain, and every measure joins in against it.
  const base = dimension ? dimension.table : measures[0].table;
  const wanted = new Set(measures.map((measure) => measure.table));
  if (dimension) wanted.add(dimension.table);

  const joins = planJoins(model, base, wanted);
  if (!joins) return null;

  const selected: string[] = [];
  if (dimension) {
    selected.push(`${qualify(dimension.table, dimension.column)} AS ${quoteIdent(DIMENSION_ALIAS)}`);
  }
  for (const measure of measures) {
    const aggregation = measure.aggregation.toUpperCase();
    const fn = aggregation === "MEAN" ? "AVG" : aggregation;
    selected.push(`${fn}(${measure.expression}) AS ${quoteIdent(measure.id)}`);
  }

  const conditions: string[] = [];
  for (const filter of request.filters ?? []) {
    const condition = filter.kind === "area" ? areaCondition(filter) : valueCondition(filter);
    if (condition) conditions.push(condition);
  }

  let sql = `SELECT ${selected.join(", ")} FROM ${quoteIdent(base)}`;
  for (const join of joins) {
    sql += ` LEFT JOIN ${quoteIdent(join.table)} ON ${join.on}`;
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  if (dimension) {
    sql += ` GROUP BY 1 ORDER BY 2 DESC NULLS LAST`;
  }
  if (request.limit !== undefined && Number.isInteger(request.limit) && request.limit > 0) {
    sql += ` LIMIT ${request.limit}`;
  }

  return {
    sql,
    measures,
    dimensionColumn: dimension ? DIMENSION_ALIAS : undefined,
  };
}
