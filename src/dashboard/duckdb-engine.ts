/**
 * DuckDB-Wasm, the dashboard's query engine.
 *
 * **This is the only module in the app that may import `@duckdb/duckdb-wasm`,
 * and nothing may import this module statically.** It is reached exclusively
 * through `await import("@/dashboard/duckdb-engine")`, from the standalone
 * bootstrap and from the complementary panel's open handler. That is what keeps
 * the wasm, its worker and the driver out of the map application's bundle —
 * `manualChunks` names the chunk `vendor-duckdb`, but only the absence of a
 * static import keeps it off the entry graph. See plans/dashboard-capabilities.md §4.
 *
 * The bundle files are imported with `?url` rather than left to the package's
 * jsDelivr default, so a deployment behind a strict CSP or without internet
 * access still works. As with the MapLibre worker (see the comment block in
 * `MapView.tsx`), the Vite import suffix here is load-bearing and a wrong one
 * fails silently in production builds only.
 */
import * as duckdb from "@duckdb/duckdb-wasm";

import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

import type { SemanticModel } from "@/dashboard/semantic-model";

/**
 * One result row, column name to value.
 *
 * Plain objects rather than the Arrow `Table` DuckDB returns: the package
 * bundles its own copy of apache-arrow, whose `Table` is a structurally
 * different type from the app's, and dashboard results are aggregates — tens of
 * rows, not the batches the map's parquet reader streams.
 */
export type QueryRow = Record<string, unknown>;

export interface DuckDbEngine {
  /** Run one SQL statement and return its rows. */
  query: (sql: string) => Promise<QueryRow[]>;
  /** Release the connection, worker and wasm instance. */
  close: () => Promise<void>;
}

let enginePromise: Promise<DuckDbEngine> | null = null;

/**
 * The engine, initialised at most once.
 *
 * Memoizes the *promise*, not a "ready" boolean: several widgets query on the
 * first paint, and a boolean would let each of them start its own multi-megabyte
 * download. On failure the memo is cleared so a later attempt can retry — the
 * same shape as `ensureParquetWasmInit` in `src/layers/parquet-loader.ts`.
 */
export function ensureDuckDb(): Promise<DuckDbEngine> {
  return (enginePromise ??= initEngine().catch((err) => {
    enginePromise = null;
    throw err;
  }));
}

async function initEngine(): Promise<DuckDbEngine> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (!bundle.mainWorker) {
    throw new Error("DuckDB selected a bundle without a worker");
  }

  const worker = new Worker(bundle.mainWorker, { type: "module" });
  // VoidLogger: DuckDB's ConsoleLogger narrates every query at info level, which
  // buries the app's own warnings.
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const connection = await db.connect();

  return {
    query: async (sql) => {
      const result = await connection.query(sql);
      return result.toArray().map((row) => row.toJSON() as QueryRow);
    },
    close: async () => {
      await connection.close();
      await db.terminate();
      worker.terminate();
    },
  };
}

/**
 * Register each model table as a view over its parquet URL, so queries can name
 * tables rather than repeat `read_parquet('…')`.
 *
 * DuckDB reads the file over HTTP range requests, so the host must answer those
 * with CORS; a table whose URL cannot be read fails here rather than inside
 * every widget's query.
 */
export async function registerTables(
  engine: DuckDbEngine,
  model: SemanticModel,
): Promise<void> {
  for (const table of model.tables.values()) {
    const url = table.url.replace(/'/g, "''");
    await engine.query(
      `CREATE OR REPLACE VIEW "${table.name}" AS SELECT * FROM read_parquet('${url}')`,
    );
  }
}

/** Drop the memoized engine without closing it — for tests. */
export function resetDuckDbForTests(): void {
  enginePromise = null;
}
