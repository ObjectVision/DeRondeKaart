import { tableFromIPC, Table } from "apache-arrow";
import initGeoParquet, {
  readGeoParquet,
} from "@geoarrow/geoparquet-wasm/esm";
import initParquet, { readParquet } from "parquet-wasm";

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
export async function loadGeoParquetBatches(
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
 */
export async function loadParquetBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  await ensureParquetWasmInit();

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
