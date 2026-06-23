import { tableFromIPC, Table } from "apache-arrow";
import initGeoParquet, {
  readGeoParquet,
} from "@geoarrow/geoparquet-wasm/esm";
import initParquet, { readParquet, readParquetStream } from "parquet-wasm";
import { loadTableCached } from "./table-cache";

let geoParquetWasmInitialized = false;
let parquetWasmInitialized = false;

async function ensureGeoParquetWasmInit() {
  if (!geoParquetWasmInitialized) {
    await initGeoParquet();
    geoParquetWasmInitialized = true;
  }
}

async function ensureParquetWasmInit() {
  if (!parquetWasmInitialized) {
    await initParquet();
    parquetWasmInitialized = true;
  }
}

export interface BatchCallback {
  (batchIndex: number, table: Table): void;
}

function emitBatches(arrowTable: Table, onBatch: BatchCallback) {
  const batchCount = arrowTable.batches.length;
  if (batchCount <= 1) {
    onBatch(0, arrowTable);
    return Promise.resolve();
  }
  return (async () => {
    for (let i = 0; i < batchCount; i++) {
      const partialTable = new Table(arrowTable.batches.slice(0, i + 1));
      onBatch(i, partialTable);
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
}

/**
 * Loads a GeoParquet file (WKB-encoded geometry) and converts geometries to
 * native GeoArrow encoding via @geoarrow/geoparquet-wasm.
 */
export function loadGeoParquetBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  return loadTableCached(url, (cb) => loadGeoParquetBatchesUncached(url, cb), onBatch);
}

async function loadGeoParquetBatchesUncached(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  await ensureGeoParquetWasmInit();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch geoparquet file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const wasmTable = readGeoParquet(new Uint8Array(buffer));
  const arrowTable = tableFromIPC(wasmTable.intoIPCStream());

  await emitBatches(arrowTable, onBatch);
  return arrowTable;
}

/**
 * Loads a Parquet file whose geometry column is already stored using GeoArrow
 * encoding (not WKB). Read directly with parquet-wasm — no geometry conversion
 * is performed. See https://github.com/geoarrow/deck.gl-geoarrow#parquet.
 *
 * Streams record batches over HTTP Range requests (206 Partial Content):
 * `readParquetStream` reads the footer, then fetches column chunks on demand,
 * yielding one wasm RecordBatch per batch. Each batch is converted to a JS Arrow
 * batch and emitted cumulatively so deck.gl renders progressively without
 * buffering the whole file in memory.
 *
 * Falls back to the whole-file `readParquet` path if streaming throws (e.g. a
 * server without range support). Unlike the geoparquet WKB reader, parquet-wasm
 * stream errors surface through the normal promise/stream reject path, so this
 * fallback is reliably reached.
 */
export function loadParquetBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  return loadTableCached(url, (cb) => loadParquetBatchesUncached(url, cb), onBatch);
}

async function loadParquetBatchesUncached(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  await ensureParquetWasmInit();

  try {
    return await streamParquetBatches(url, onBatch);
  } catch (err) {
    console.warn(
      `Streaming parquet failed for "${url}", falling back to whole-file load:`,
      err,
    );
    return await loadParquetWhole(url, onBatch);
  }
}

async function streamParquetBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  const stream = await readParquetStream(url);

  // Use an explicit reader rather than `for await...of`: async iteration over a
  // ReadableStream is not supported in all browsers (e.g. Safari), whereas
  // getReader() is universal.
  const reader = stream.getReader();
  const batches: Table["batches"] = [];
  let batchIndex = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // intoIPCStream yields a self-contained IPC stream (schema + this batch)
      // that Arrow JS parses into a single-batch Table.
      const batchTable = tableFromIPC(value.intoIPCStream());
      batches.push(...batchTable.batches);
      onBatch(batchIndex++, new Table(batches));
      // Yield to the event loop so deck.gl can paint between batches.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    reader.releaseLock();
  }

  if (batchIndex === 0) {
    // Empty file — still emit an empty table so callers behave consistently.
    const empty = new Table(batches);
    onBatch(0, empty);
    return empty;
  }
  return new Table(batches);
}

async function loadParquetWhole(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch parquet file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const wasmTable = readParquet(new Uint8Array(buffer));
  const arrowTable = tableFromIPC(wasmTable.intoIPCStream());

  await emitBatches(arrowTable, onBatch);
  return arrowTable;
}
