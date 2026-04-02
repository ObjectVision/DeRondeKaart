import { tableFromIPC, Table } from "apache-arrow";
import initGeoParquet, {
  readGeoParquet,
} from "@geoarrow/geoparquet-wasm/esm";

let wasmInitialized = false;

async function ensureWasmInit() {
  if (!wasmInitialized) {
    await initGeoParquet();
    wasmInitialized = true;
  }
}

export interface BatchCallback {
  (batchIndex: number, table: Table): void;
}

/**
 * Loads a GeoParquet file, converting WKB geometries to native GeoArrow encoding.
 * Calls onBatch per record batch for incremental rendering.
 */
export async function loadParquetBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  await ensureWasmInit();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch parquet file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const wasmTable = readGeoParquet(new Uint8Array(buffer));
  const arrowTable = tableFromIPC(wasmTable.intoIPCStream());

  // Emit each record batch individually for incremental rendering
  for (let i = 0; i < arrowTable.batches.length; i++) {
    const partialTable = new Table(arrowTable.batches.slice(0, i + 1));
    onBatch(i, partialTable);
    // Yield to allow React to flush the state update and render
    await new Promise((r) => setTimeout(r, 0));
  }

  return arrowTable;
}
