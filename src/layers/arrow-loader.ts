import { tableFromIPC, Table } from "apache-arrow";
import type { BatchCallback } from "./parquet-loader";

/**
 * Loads an Arrow IPC file (.arrows / .arrow / .feather).
 * Calls onBatch per record batch for incremental rendering.
 */
export async function loadArrowBatches(
  url: string,
  onBatch: BatchCallback,
): Promise<Table> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch arrow file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  const arrowTable = tableFromIPC(new Uint8Array(buffer));

  const batchCount = arrowTable.batches.length;
  if (batchCount <= 1) {
    onBatch(0, arrowTable);
  } else {
    for (let i = 0; i < batchCount; i++) {
      const partialTable = new Table(arrowTable.batches.slice(0, i + 1));
      onBatch(i, partialTable);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return arrowTable;
}
