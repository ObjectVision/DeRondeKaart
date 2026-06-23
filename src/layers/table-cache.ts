import type { Table } from "apache-arrow";
import type { BatchCallback } from "./parquet-loader";

/**
 * URL-keyed cache of parsed Arrow tables, shared across all loaders.
 *
 * Keyed on the source URL, so the same file is fetched + parsed once even when
 * it is added to both map A and map B, or referenced by multiple layer ids in
 * layers.json. Stores the in-flight Promise (not the resolved Table) so that
 * concurrent loads of the same URL dedupe instead of racing two fetches.
 */
const tableCache = new globalThis.Map<string, Promise<Table>>();

/**
 * Wrap a real loader with URL caching.
 *
 * Cache miss: runs `runLoad`, which emits record batches progressively to
 * `onBatch` for incremental rendering, and stores the resulting promise.
 * Cache hit: awaits the shared table and emits it to `onBatch` in a single
 * batch (progressive rendering is only available to the first consumer).
 *
 * A rejected load is evicted so a later call can retry.
 */
export async function loadTableCached(
  url: string,
  runLoad: (onBatch: BatchCallback) => Promise<Table>,
  onBatch: BatchCallback,
): Promise<Table> {
  const cached = tableCache.get(url);
  if (cached) {
    const table = await cached;
    onBatch(0, table);
    return table;
  }

  const promise = runLoad(onBatch);
  tableCache.set(url, promise);
  try {
    return await promise;
  } catch (err) {
    tableCache.delete(url);
    throw err;
  }
}

/** Drop a cached table (e.g. to force a refresh of its source). */
export function invalidateTableCache(url: string): void {
  tableCache.delete(url);
}

/** Clear the entire table cache. */
export function clearTableCache(): void {
  tableCache.clear();
}
