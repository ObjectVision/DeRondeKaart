import { tableFromIPC } from "apache-arrow";
import { ParquetFile } from "@/vendor/parquet-wasm/parquet_wasm.js";
import { ensureParquetWasmInit } from "./parquet-loader";

export type ParquetRow = Record<string, unknown>;

/**
 * One row of a remote parquet file, by 0-based index, read over HTTP range
 * requests — the "Locatie informatie" sidecar lookup (see LocationInfoConfig).
 *
 * `ParquetFile.fromUrl` reads the file size and the footer once per URL;
 * `read({ offset, limit: 1 })` then skips every row group before the offset on
 * the footer's row counts alone, and fetches the column chunks of the one group
 * holding the row. Without a page index a column chunk is the smallest unit it
 * fetches, so a click costs one row group's worth of bytes — which is what the
 * row-group size of the sidecar is tuned for (see data/locatieinfo/README.md).
 *
 * Column selection is not offered: this slim parquet-wasm build has no schema
 * accessor to pick names from, so geometry is read with the rest and dropped
 * here. It is a point column — small next to the attributes.
 *
 * Both caches are keyed by URL, so a variant switch needs no reset: a URL means
 * the same document under either variant.
 */

const files = new Map<string, Promise<ParquetFile>>();

/** Recently read rows, oldest first. Small: it only saves re-clicks. */
const rows = new Map<string, Promise<ParquetRow | null>>();
const MAX_CACHED_ROWS = 32;

function openFile(url: string): Promise<ParquetFile> {
  let file = files.get(url);
  if (!file) {
    file = ensureParquetWasmInit()
      .then(() => ParquetFile.fromUrl(url))
      .catch((err: unknown) => {
        // Not cached as a failure: the next click retries, as parquet-loader does.
        files.delete(url);
        throw err;
      });
    files.set(url, file);
  }
  return file;
}

/** Arrow hands 64-bit integers back as bigint; the template wants numbers. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** True for a geometry column, which a lookup never needs. */
function isGeometry(name: string): boolean {
  return name === "geometry" || name === "geom";
}

async function readRow(url: string, row: number): Promise<ParquetRow | null> {
  const file = await openFile(url);
  const wasmTable = await file.read({ offset: row, limit: 1 });
  const table = tableFromIPC(wasmTable.intoIPCStream());
  if (table.numRows === 0) return null;

  const result: ParquetRow = {};
  for (const field of table.schema.fields) {
    if (isGeometry(field.name)) continue;
    result[field.name] = plain(table.getChild(field.name)?.get(0));
  }
  return result;
}

/**
 * The row at `row` (0-based), or null when the file has fewer rows. Network and
 * decode failures reject, and are not cached.
 */
export function fetchParquetRow(url: string, row: number): Promise<ParquetRow | null> {
  const key = `${url}#${row}`;
  const cached = rows.get(key);
  if (cached) {
    // Re-insert so the Map's insertion order doubles as recency.
    rows.delete(key);
    rows.set(key, cached);
    return cached;
  }

  const pending = readRow(url, row).catch((err: unknown) => {
    rows.delete(key);
    throw err;
  });
  rows.set(key, pending);
  while (rows.size > MAX_CACHED_ROWS) {
    const oldest = rows.keys().next().value as string;
    rows.delete(oldest);
  }
  return pending;
}

/** Forget every open file and cached row. For tests. */
export function clearParquetRowCache(): void {
  files.clear();
  rows.clear();
}
