/* tslint:disable */
/* eslint-disable */
/**
 * Read a Parquet file into Arrow data.
 *
 * This returns an Arrow table in WebAssembly memory. To transfer the Arrow table to JavaScript
 * memory you have two options:
 *
 * - (Easier): Call {@linkcode Table.intoIPCStream} to construct a buffer that can be parsed with
 *   Arrow JS's `tableFromIPC` function.
 * - (More performant but bleeding edge): Call {@linkcode Table.intoFFI} to construct a data
 *   representation that can be parsed zero-copy from WebAssembly with
 *   [arrow-js-ffi](https://github.com/kylebarron/arrow-js-ffi) using `parseTable`.
 *
 * Example with IPC stream:
 *
 * ```js
 * import { tableFromIPC } from "apache-arrow";
 * import initWasm, {readParquet} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 *
 * const resp = await fetch("https://example.com/file.parquet");
 * const parquetUint8Array = new Uint8Array(await resp.arrayBuffer());
 * const arrowWasmTable = readParquet(parquetUint8Array);
 * const arrowTable = tableFromIPC(arrowWasmTable.intoIPCStream());
 * ```
 *
 * Example with `arrow-js-ffi`:
 *
 * ```js
 * import { parseTable } from "arrow-js-ffi";
 * import initWasm, {readParquet, wasmMemory} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 * const WASM_MEMORY = wasmMemory();
 *
 * const resp = await fetch("https://example.com/file.parquet");
 * const parquetUint8Array = new Uint8Array(await resp.arrayBuffer());
 * const arrowWasmTable = readParquet(parquetUint8Array);
 * const ffiTable = arrowWasmTable.intoFFI();
 * const arrowTable = parseTable(
 *   WASM_MEMORY.buffer,
 *   ffiTable.arrayAddrs(),
 *   ffiTable.schemaAddr()
 * );
 * ```
 *
 * @param parquet_file Uint8Array containing Parquet data
 * @param options
 *
 *    Options for reading Parquet data. Optional keys include:
 *
 *    - `batchSize`: The number of rows in each batch. If not provided, the upstream parquet
 *           default is 1024.
 *    - `rowGroups`: Only read data from the provided row group indexes.
 *    - `limit`: Provide a limit to the number of rows to be read.
 *    - `offset`: Provide an offset to skip over the given number of rows.
 *    - `columns`: The column names from the file to read.
 */
export function readParquet(parquet_file: Uint8Array, options?: ReaderOptions | null): Table;
/**
 * Read an Arrow schema from a Parquet file in memory.
 *
 * This returns an Arrow schema in WebAssembly memory. To transfer the Arrow schema to JavaScript
 * memory you have two options:
 *
 * - (Easier): Call {@linkcode Schema.intoIPCStream} to construct a buffer that can be parsed with
 *   Arrow JS's `tableFromIPC` function. This results in an Arrow JS Table with zero rows but a
 *   valid schema.
 * - (More performant but bleeding edge): Call {@linkcode Schema.intoFFI} to construct a data
 *   representation that can be parsed zero-copy from WebAssembly with
 *   [arrow-js-ffi](https://github.com/kylebarron/arrow-js-ffi) using `parseSchema`.
 *
 * Example with IPC Stream:
 *
 * ```js
 * import { tableFromIPC } from "apache-arrow";
 * import initWasm, {readSchema} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 *
 * const resp = await fetch("https://example.com/file.parquet");
 * const parquetUint8Array = new Uint8Array(await resp.arrayBuffer());
 * const arrowWasmSchema = readSchema(parquetUint8Array);
 * const arrowTable = tableFromIPC(arrowWasmSchema.intoIPCStream());
 * const arrowSchema = arrowTable.schema;
 * ```
 *
 * Example with `arrow-js-ffi`:
 *
 * ```js
 * import { parseSchema } from "arrow-js-ffi";
 * import initWasm, {readSchema, wasmMemory} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 * const WASM_MEMORY = wasmMemory();
 *
 * const resp = await fetch("https://example.com/file.parquet");
 * const parquetUint8Array = new Uint8Array(await resp.arrayBuffer());
 * const arrowWasmSchema = readSchema(parquetUint8Array);
 * const ffiSchema = arrowWasmSchema.intoFFI();
 * const arrowTable = parseSchema(WASM_MEMORY.buffer, ffiSchema.addr());
 * const arrowSchema = arrowTable.schema;
 * ```
 *
 * @param parquet_file Uint8Array containing Parquet data
 */
export function readSchema(parquet_file: Uint8Array): Schema;
/**
 * Read a Parquet file into a stream of Arrow `RecordBatch`es.
 *
 * This returns a ReadableStream containing RecordBatches in WebAssembly memory. To transfer the
 * Arrow table to JavaScript memory you have two options:
 *
 * - (Easier): Call {@linkcode RecordBatch.intoIPCStream} to construct a buffer that can be parsed
 *   with Arrow JS's `tableFromIPC` function. (The table will have a single internal record
 *   batch).
 * - (More performant but bleeding edge): Call {@linkcode RecordBatch.intoFFI} to construct a data
 *   representation that can be parsed zero-copy from WebAssembly with
 *   [arrow-js-ffi](https://github.com/kylebarron/arrow-js-ffi) using `parseRecordBatch`.
 *
 * Example with IPC stream:
 *
 * ```js
 * import { tableFromIPC, Table } from "apache-arrow";
 * import initWasm, {readParquetStream} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 *
 * const stream = await readParquetStream(url);
 *
 * const batches = [];
 * for await (const wasmRecordBatch of stream) {
 *   const arrowTable = tableFromIPC(wasmRecordBatch.intoIPCStream());
 *   batches.push(...arrowTable.batches);
 * }
 * const table = new Table(batches);
 * ```
 *
 * Example with `arrow-js-ffi`:
 *
 * ```js
 * import { Table } from "apache-arrow";
 * import { parseRecordBatch } from "arrow-js-ffi";
 * import initWasm, {readParquetStream, wasmMemory} from "parquet-wasm";
 *
 * // Instantiate the WebAssembly context
 * await initWasm();
 * const WASM_MEMORY = wasmMemory();
 *
 * const stream = await readParquetStream(url);
 *
 * const batches = [];
 * for await (const wasmRecordBatch of stream) {
 *   const ffiRecordBatch = wasmRecordBatch.intoFFI();
 *   const recordBatch = parseRecordBatch(
 *     WASM_MEMORY.buffer,
 *     ffiRecordBatch.arrayAddr(),
 *     ffiRecordBatch.schemaAddr(),
 *     true
 *   );
 *   batches.push(recordBatch);
 * }
 * const table = new Table(batches);
 * ```
 *
 * @param url URL to Parquet file
 */
export function readParquetStream(url: string, content_length?: number | null): Promise<ReadableStream>;
/**
 * Returns a handle to this wasm instance's `WebAssembly.Memory`
 */
export function wasmMemory(): Memory;
/**
 * Returns a handle to this wasm instance's `WebAssembly.Table` which is the indirect function
 * table used by Rust
 */
export function _functionTable(): FunctionTable;
/**
 * Supported compression algorithms.
 *
 * Codecs added in format version X.Y can be read by readers based on X.Y and later.
 * Codec support may vary between readers based on the format version and
 * libraries available at runtime.
 */
export enum Compression {
  UNCOMPRESSED = 0,
  SNAPPY = 1,
  GZIP = 2,
  BROTLI = 3,
  /**
   * @deprecated as of Parquet 2.9.0.
   * Switch to LZ4_RAW
   */
  LZ4 = 4,
  ZSTD = 5,
  LZ4_RAW = 6,
  LZO = 7,
}
/**
 * Encodings supported by Parquet.
 * Not all encodings are valid for all types. These enums are also used to specify the
 * encoding of definition and repetition levels.
 */
export enum Encoding {
  /**
   * Default byte encoding.
   * - BOOLEAN - 1 bit per value, 0 is false; 1 is true.
   * - INT32 - 4 bytes per value, stored as little-endian.
   * - INT64 - 8 bytes per value, stored as little-endian.
   * - FLOAT - 4 bytes per value, stored as little-endian.
   * - DOUBLE - 8 bytes per value, stored as little-endian.
   * - BYTE_ARRAY - 4 byte length stored as little endian, followed by bytes.
   * - FIXED_LEN_BYTE_ARRAY - just the bytes are stored.
   */
  PLAIN = 0,
  /**
   * **Deprecated** dictionary encoding.
   *
   * The values in the dictionary are encoded using PLAIN encoding.
   * Since it is deprecated, RLE_DICTIONARY encoding is used for a data page, and
   * PLAIN encoding is used for dictionary page.
   */
  PLAIN_DICTIONARY = 1,
  /**
   * Group packed run length encoding.
   *
   * Usable for definition/repetition levels encoding and boolean values.
   */
  RLE = 2,
  /**
   * Bit packed encoding.
   *
   * This can only be used if the data has a known max width.
   * Usable for definition/repetition levels encoding.
   */
  BIT_PACKED = 3,
  /**
   * Delta encoding for integers, either INT32 or INT64.
   *
   * Works best on sorted data.
   */
  DELTA_BINARY_PACKED = 4,
  /**
   * Encoding for byte arrays to separate the length values and the data.
   *
   * The lengths are encoded using DELTA_BINARY_PACKED encoding.
   */
  DELTA_LENGTH_BYTE_ARRAY = 5,
  /**
   * Incremental encoding for byte arrays.
   *
   * Prefix lengths are encoded using DELTA_BINARY_PACKED encoding.
   * Suffixes are stored using DELTA_LENGTH_BYTE_ARRAY encoding.
   */
  DELTA_BYTE_ARRAY = 6,
  /**
   * Dictionary encoding.
   *
   * The ids are encoded using the RLE encoding.
   */
  RLE_DICTIONARY = 7,
  /**
   * Encoding for floating-point data.
   *
   * K byte-streams are created where K is the size in bytes of the data type.
   * The individual bytes of an FP value are scattered to the corresponding stream and
   * the streams are concatenated.
   * This itself does not reduce the size of the data but can lead to better compression
   * afterwards.
   */
  BYTE_STREAM_SPLIT = 8,
}
/**
 * The Parquet version to use when writing
 */
export enum WriterVersion {
  V1 = 0,
  V2 = 1,
}
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */
type ReadableStreamType = "bytes";

export type ReaderOptions = {
    /* The number of rows in each batch. If not provided, the upstream parquet default is 1024. */
    batchSize?: number;
    /* Only read data from the provided row group indexes. */
    rowGroups?: number[];
    /* Provide a limit to the number of rows to be read. */
    limit?: number;
    /* Provide an offset to skip over the given number of rows. */
    offset?: number;
    /* The column names from the file to read. */
    columns?: string[];
    /* The number of concurrent requests to make in the async reader. */
    concurrency?: number;
};



export type FunctionTable = WebAssembly.Table;



export type Memory = WebAssembly.Memory;



export type SchemaMetadata = Map<string, string>;


/**
 * Metadata for a Parquet column chunk.
 */
export class ColumnChunkMetaData {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Total number of values in this column chunk.
   */
  numValues(): number;
  /**
   * Path (or identifier) of this column.
   */
  columnPath(): string[];
  /**
   * Compression for this column.
   */
  compression(): Compression;
  /**
   * Byte offset in `file_path()`.
   */
  fileOffset(): bigint;
  /**
   * Returns the total compressed data size of this column chunk.
   */
  compressedSize(): number;
  /**
   * Returns the total uncompressed data size of this column chunk.
   */
  uncompressedSize(): number;
  /**
   * All encodings used for this column.
   */
  encodings(): any[];
  /**
   * File where the column chunk is stored.
   *
   * If not set, assumed to belong to the same file as the metadata.
   * This path is relative to the current file.
   */
  filePath(): string | undefined;
}
/**
 * An Arrow array exported to FFI.
 *
 * Using [`arrow-js-ffi`](https://github.com/kylebarron/arrow-js-ffi), you can view or copy Arrow
 * these objects to JavaScript.
 *
 * Note that this also includes an ArrowSchema C struct as well, so that extension type
 * information can be maintained.
 * ## Memory management
 *
 * Note that this array will not be released automatically. You need to manually call `.free()` to
 * release memory.
 */
export class FFIData {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Access the pointer to the
   * [`ArrowArray`](https://arrow.apache.org/docs/format/CDataInterface.html#structure-definitions)
   * struct. This can be viewed or copied (without serialization) to an Arrow JS `RecordBatch` by
   * using [`arrow-js-ffi`](https://github.com/kylebarron/arrow-js-ffi). You can access the
   * [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory)
   * instance by using {@linkcode wasmMemory}.
   *
   * **Example**:
   *
   * ```ts
   * import { parseRecordBatch } from "arrow-js-ffi";
   *
   * const wasmRecordBatch: FFIRecordBatch = ...
   * const wasmMemory: WebAssembly.Memory = wasmMemory();
   *
   * // Pass `true` to copy arrays across the boundary instead of creating views.
   * const jsRecordBatch = parseRecordBatch(
   *   wasmMemory.buffer,
   *   wasmRecordBatch.arrayAddr(),
   *   wasmRecordBatch.schemaAddr(),
   *   true
   * );
   * ```
   */
  arrayAddr(): number;
  /**
   * Access the pointer to the
   * [`ArrowSchema`](https://arrow.apache.org/docs/format/CDataInterface.html#structure-definitions)
   * struct. This can be viewed or copied (without serialization) to an Arrow JS `Field` by
   * using [`arrow-js-ffi`](https://github.com/kylebarron/arrow-js-ffi). You can access the
   * [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory)
   * instance by using {@linkcode wasmMemory}.
   *
   * **Example**:
   *
   * ```ts
   * import { parseRecordBatch } from "arrow-js-ffi";
   *
   * const wasmRecordBatch: FFIRecordBatch = ...
   * const wasmMemory: WebAssembly.Memory = wasmMemory();
   *
   * // Pass `true` to copy arrays across the boundary instead of creating views.
   * const jsRecordBatch = parseRecordBatch(
   *   wasmMemory.buffer,
   *   wasmRecordBatch.arrayAddr(),
   *   wasmRecordBatch.schemaAddr(),
   *   true
   * );
   * ```
   */
  schemaAddr(): number;
}
export class FFISchema {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Access the pointer to the
   * [`ArrowSchema`](https://arrow.apache.org/docs/format/CDataInterface.html#structure-definitions)
   * struct. This can be viewed or copied (without serialization) to an Arrow JS `Field` by
   * using [`arrow-js-ffi`](https://github.com/kylebarron/arrow-js-ffi). You can access the
   * [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory)
   * instance by using {@linkcode wasmMemory}.
   *
   * **Example**:
   *
   * ```ts
   * import { parseRecordBatch } from "arrow-js-ffi";
   *
   * const wasmRecordBatch: FFIRecordBatch = ...
   * const wasmMemory: WebAssembly.Memory = wasmMemory();
   *
   * // Pass `true` to copy arrays across the boundary instead of creating views.
   * const jsRecordBatch = parseRecordBatch(
   *   wasmMemory.buffer,
   *   wasmRecordBatch.arrayAddr(),
   *   wasmRecordBatch.schemaAddr(),
   *   true
   * );
   * ```
   */
  addr(): number;
}
/**
 * A representation of an Arrow C Stream in WebAssembly memory exposed as FFI-compatible
 * structs through the Arrow C Data Interface.
 *
 * Unlike other Arrow implementations outside of JS, this always stores the "stream" fully
 * materialized as a sequence of Arrow chunks.
 */
export class FFIStream {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the pointer to one ArrowArray FFI struct for a given chunk index and column index
   *
   * Access the pointer to one
   * [`ArrowArray`](https://arrow.apache.org/docs/format/CDataInterface.html#structure-definitions)
   * struct representing one of the internal `RecordBatch`es. This can be viewed or copied (without serialization) to an Arrow JS `RecordBatch` by
   * using [`arrow-js-ffi`](https://github.com/kylebarron/arrow-js-ffi). You can access the
   * [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory)
   * instance by using {@linkcode wasmMemory}.
   *
   * **Example**:
   *
   * ```ts
   * import * as arrow from "apache-arrow";
   * import { parseRecordBatch } from "arrow-js-ffi";
   *
   * const wasmTable: FFITable = ...
   * const wasmMemory: WebAssembly.Memory = wasmMemory();
   *
   * const jsBatches: arrow.RecordBatch[] = []
   * for (let i = 0; i < wasmTable.numBatches(); i++) {
   *   // Pass `true` to copy arrays across the boundary instead of creating views.
   *   const jsRecordBatch = parseRecordBatch(
   *     wasmMemory.buffer,
   *     wasmTable.arrayAddr(i),
   *     wasmTable.schemaAddr(),
   *     true
   *   );
   *   jsBatches.push(jsRecordBatch);
   * }
   * const jsTable = new arrow.Table(jsBatches);
   * ```
   *
   * @param chunk number The chunk index to use
   * @returns number pointer to an ArrowArray FFI struct in Wasm memory
   */
  arrayAddr(chunk: number): number;
  /**
   * Get the total number of elements in this stream
   */
  numArrays(): number;
  arrayAddrs(): Uint32Array;
  /**
   * Get the pointer to the ArrowSchema FFI struct
   */
  schemaAddr(): number;
  drop(): void;
}
/**
 * Metadata for a Parquet file.
 */
export class FileMetaData {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * String message for application that wrote this file.
   *
   * This should have the following format:
   * `<application> version <application version> (build <application build hash>)`.
   *
   * ```shell
   * parquet-mr version 1.8.0 (build 0fda28af84b9746396014ad6a415b90592a98b3b)
   * ```
   */
  createdBy(): string | undefined;
  /**
   * Returns key_value_metadata of this file.
   */
  keyValueMetadata(): Map<any, any>;
  /**
   * Returns version of this file.
   */
  version(): number;
  /**
   * Returns number of rows in the file.
   */
  numRows(): number;
}
export class IntoUnderlyingByteSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableByteStreamController): Promise<any>;
  start(controller: ReadableByteStreamController): void;
  cancel(): void;
  readonly autoAllocateChunkSize: number;
  readonly type: ReadableStreamType;
}
export class IntoUnderlyingSink {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  abort(reason: any): Promise<any>;
  close(): Promise<any>;
  write(chunk: any): Promise<any>;
}
export class IntoUnderlyingSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableStreamDefaultController): Promise<any>;
  cancel(): void;
}
export class ParquetFile {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Read from the Parquet file in an async fashion.
   *
   * @param options
   *
   *    Options for reading Parquet data. Optional keys include:
   *
   *    - `batchSize`: The number of rows in each batch. If not provided, the upstream parquet
   *           default is 1024.
   *    - `rowGroups`: Only read data from the provided row group indexes.
   *    - `limit`: Provide a limit to the number of rows to be read.
   *    - `offset`: Provide an offset to skip over the given number of rows.
   *    - `columns`: The column names from the file to read.
   */
  read(options?: ReaderOptions | null): Promise<Table>;
  /**
   * Create a readable stream of record batches.
   *
   * Each item in the stream will be a {@linkcode RecordBatch}.
   *
   * @param options
   *
   *    Options for reading Parquet data. Optional keys include:
   *
   *    - `batchSize`: The number of rows in each batch. If not provided, the upstream parquet
   *           default is 1024.
   *    - `rowGroups`: Only read data from the provided row group indexes.
   *    - `limit`: Provide a limit to the number of rows to be read.
   *    - `offset`: Provide an offset to skip over the given number of rows.
   *    - `columns`: The column names from the file to read.
   *    - `concurrency`: The number of concurrent requests to make
   */
  stream(options?: ReaderOptions | null): Promise<ReadableStream>;
  /**
   * Construct a ParquetFile from a new URL.
   */
  static fromUrl(url: string): Promise<ParquetFile>;
  /**
   * Construct a ParquetFile from a new [Blob] or [File] handle.
   *
   * [Blob]: https://developer.mozilla.org/en-US/docs/Web/API/Blob
   * [File]: https://developer.mozilla.org/en-US/docs/Web/API/File
   *
   * Safety: Do not use this in a multi-threaded environment,
   * (transitively depends on `!Send` `web_sys::Blob`)
   */
  static fromFile(handle: Blob): Promise<ParquetFile>;
  schema(): Schema;
  metadata(): ParquetMetaData;
}
/**
 * Global Parquet metadata.
 */
export class ParquetMetaData {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Returns row group metadata for all row groups
   */
  rowGroups(): RowGroupMetaData[];
  /**
   * Returns file metadata as reference.
   */
  fileMetadata(): FileMetaData;
  /**
   * Returns number of row groups in this file.
   */
  numRowGroups(): number;
  /**
   * Returns row group metadata for `i`th position.
   * Position should be less than number of row groups `num_row_groups`.
   */
  rowGroup(i: number): RowGroupMetaData;
}
/**
 * A group of columns of equal length in WebAssembly memory with an associated {@linkcode Schema}.
 */
export class RecordBatch {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Override the schema of this [`RecordBatch`]
   *
   * Returns an error if `schema` is not a superset of the current schema
   * as determined by [`Schema::contains`]
   */
  withSchema(schema: Schema): RecordBatch;
  /**
   * Consume this RecordBatch and convert to an Arrow IPC Stream buffer
   */
  intoIPCStream(): Uint8Array;
  /**
   * Returns the total number of bytes of memory occupied physically by this batch.
   */
  getArrayMemorySize(): number;
  /**
   * Return a new RecordBatch where each column is sliced
   * according to `offset` and `length`
   */
  slice(offset: number, length: number): RecordBatch;
  /**
   * Export this RecordBatch to FFI structs according to the Arrow C Data Interface.
   *
   * This method **does not consume** the RecordBatch, so you must remember to call {@linkcode
   * RecordBatch.free} to release the resources. The underlying arrays are reference counted, so
   * this method does not copy data, it only prevents the data from being released.
   */
  toFFI(): FFIData;
  /**
   * Export this RecordBatch to FFI structs according to the Arrow C Data Interface.
   *
   * This method **does consume** the RecordBatch, so the original RecordBatch will be
   * inaccessible after this call. You must still call {@linkcode FFIRecordBatch.free} after
   * you've finished using the FFIRecordBatch.
   */
  intoFFI(): FFIData;
  /**
   * The number of columns in this RecordBatch.
   */
  readonly numColumns: number;
  /**
   * The {@linkcode Schema} of this RecordBatch.
   */
  readonly schema: Schema;
  /**
   * The number of rows in this RecordBatch.
   */
  readonly numRows: number;
}
/**
 * Metadata for a Parquet row group.
 */
export class RowGroupMetaData {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Number of columns in this row group.
   */
  numColumns(): number;
  /**
   * Total size of all compressed column data in this row group.
   */
  compressedSize(): number;
  /**
   * Total byte size of all uncompressed column data in this row group.
   */
  totalByteSize(): number;
  /**
   * Returns column chunk metadata for `i`th column.
   */
  column(i: number): ColumnChunkMetaData;
  /**
   * Returns column chunk metadata for all columns
   */
  columns(): ColumnChunkMetaData[];
  /**
   * Number of rows in this row group.
   */
  numRows(): number;
}
/**
 * A named collection of types that defines the column names and types in a RecordBatch or Table
 * data structure.
 *
 * A Schema can also contain extra user-defined metadata either at the Table or Column level.
 * Column-level metadata is often used to define [extension
 * types](https://arrow.apache.org/docs/format/Columnar.html#extension-types).
 */
export class Schema {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Sets the metadata of this `Schema` to be `metadata` and returns a new object
   */
  withMetadata(metadata: SchemaMetadata): Schema;
  /**
   * Consume this schema and convert to an Arrow IPC Stream buffer
   */
  intoIPCStream(): Uint8Array;
  /**
   * Export this schema to an FFISchema object, which can be read with arrow-js-ffi.
   *
   * This method **does not consume** the Schema, so you must remember to call {@linkcode
   * Schema.free} to release the resources. The underlying arrays are reference counted, so
   * this method does not copy data, it only prevents the data from being released.
   */
  toFFI(): FFISchema;
  /**
   * Find the index of the column with the given name.
   */
  indexOf(name: string): number;
  /**
   * Export this Table to FFI structs according to the Arrow C Data Interface.
   *
   * This method **does consume** the Table, so the original Table will be
   * inaccessible after this call. You must still call {@linkcode FFITable.free} after
   * you've finished using the FFITable.
   */
  intoFFI(): FFISchema;
  /**
   * Returns an immutable reference to the Map of custom metadata key-value pairs.
   */
  metadata(): SchemaMetadata;
}
/**
 * A Table in WebAssembly memory conforming to the Apache Arrow spec.
 *
 * A Table consists of one or more {@linkcode RecordBatch} objects plus a {@linkcode Schema} that
 * each RecordBatch conforms to.
 */
export class Table {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Access a RecordBatch from the Table by index.
   *
   * @param index The positional index of the RecordBatch to retrieve.
   * @returns a RecordBatch or `null` if out of range.
   */
  recordBatch(index: number): RecordBatch | undefined;
  recordBatches(): RecordBatch[];
  /**
   * Create a table from an Arrow IPC Stream buffer
   */
  static fromIPCStream(buf: Uint8Array): Table;
  /**
   * Consume this table and convert to an Arrow IPC Stream buffer
   */
  intoIPCStream(): Uint8Array;
  /**
   * Returns the total number of bytes of memory occupied physically by all batches in this
   * table.
   */
  getArrayMemorySize(): number;
  /**
   * Export this Table to FFI structs according to the Arrow C Data Interface.
   *
   * This method **does not consume** the Table, so you must remember to call {@linkcode
   * Table.free} to release the resources. The underlying arrays are reference counted, so
   * this method does not copy data, it only prevents the data from being released.
   */
  toFFI(): FFIStream;
  /**
   * Export this Table to FFI structs according to the Arrow C Data Interface.
   *
   * This method **does consume** the Table, so the original Table will be
   * inaccessible after this call. You must still call {@linkcode FFITable.free} after
   * you've finished using the FFITable.
   */
  intoFFI(): FFIStream;
  /**
   * The number of batches in the Table
   */
  readonly numBatches: number;
  /**
   * Access the Table's {@linkcode Schema}.
   */
  readonly schema: Schema;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_parquetfile_free: (a: number, b: number) => void;
  readonly parquetfile_fromFile: (a: any) => any;
  readonly parquetfile_fromUrl: (a: number, b: number) => any;
  readonly parquetfile_metadata: (a: number) => [number, number, number];
  readonly parquetfile_read: (a: number, b: number) => any;
  readonly parquetfile_schema: (a: number) => [number, number, number];
  readonly parquetfile_stream: (a: number, b: number) => any;
  readonly __wbg_columnchunkmetadata_free: (a: number, b: number) => void;
  readonly __wbg_filemetadata_free: (a: number, b: number) => void;
  readonly __wbg_parquetmetadata_free: (a: number, b: number) => void;
  readonly __wbg_rowgroupmetadata_free: (a: number, b: number) => void;
  readonly columnchunkmetadata_columnPath: (a: number) => [number, number];
  readonly columnchunkmetadata_compressedSize: (a: number) => number;
  readonly columnchunkmetadata_compression: (a: number) => number;
  readonly columnchunkmetadata_encodings: (a: number) => [number, number];
  readonly columnchunkmetadata_fileOffset: (a: number) => bigint;
  readonly columnchunkmetadata_filePath: (a: number) => [number, number];
  readonly columnchunkmetadata_numValues: (a: number) => number;
  readonly columnchunkmetadata_uncompressedSize: (a: number) => number;
  readonly filemetadata_createdBy: (a: number) => [number, number];
  readonly filemetadata_keyValueMetadata: (a: number) => [number, number, number];
  readonly filemetadata_numRows: (a: number) => number;
  readonly filemetadata_version: (a: number) => number;
  readonly parquetmetadata_fileMetadata: (a: number) => number;
  readonly parquetmetadata_numRowGroups: (a: number) => number;
  readonly parquetmetadata_rowGroup: (a: number, b: number) => number;
  readonly parquetmetadata_rowGroups: (a: number) => [number, number];
  readonly rowgroupmetadata_column: (a: number, b: number) => number;
  readonly rowgroupmetadata_columns: (a: number) => [number, number];
  readonly rowgroupmetadata_compressedSize: (a: number) => number;
  readonly rowgroupmetadata_numColumns: (a: number) => number;
  readonly rowgroupmetadata_numRows: (a: number) => number;
  readonly rowgroupmetadata_totalByteSize: (a: number) => number;
  readonly readParquet: (a: number, b: number, c: number) => [number, number, number];
  readonly readParquetStream: (a: number, b: number, c: number) => any;
  readonly readSchema: (a: number, b: number) => [number, number, number];
  readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
  readonly intounderlyingsource_cancel: (a: number) => void;
  readonly intounderlyingsource_pull: (a: number, b: any) => any;
  readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
  readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
  readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
  readonly intounderlyingbytesource_cancel: (a: number) => void;
  readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
  readonly intounderlyingbytesource_start: (a: number, b: any) => void;
  readonly intounderlyingbytesource_type: (a: number) => number;
  readonly intounderlyingsink_abort: (a: number, b: any) => any;
  readonly intounderlyingsink_close: (a: number) => any;
  readonly intounderlyingsink_write: (a: number, b: any) => any;
  readonly __wbg_recordbatch_free: (a: number, b: number) => void;
  readonly recordbatch_getArrayMemorySize: (a: number) => number;
  readonly recordbatch_intoFFI: (a: number) => [number, number, number];
  readonly recordbatch_intoIPCStream: (a: number) => [number, number, number, number];
  readonly recordbatch_numColumns: (a: number) => number;
  readonly recordbatch_numRows: (a: number) => number;
  readonly recordbatch_schema: (a: number) => number;
  readonly recordbatch_slice: (a: number, b: number, c: number) => number;
  readonly recordbatch_toFFI: (a: number) => [number, number, number];
  readonly recordbatch_withSchema: (a: number, b: number) => [number, number, number];
  readonly __wbg_ffidata_free: (a: number, b: number) => void;
  readonly __wbg_ffischema_free: (a: number, b: number) => void;
  readonly __wbg_schema_free: (a: number, b: number) => void;
  readonly _functionTable: () => any;
  readonly ffidata_arrayAddr: (a: number) => number;
  readonly ffidata_schemaAddr: (a: number) => number;
  readonly ffischema_addr: (a: number) => number;
  readonly schema_indexOf: (a: number, b: number, c: number) => [number, number, number];
  readonly schema_intoFFI: (a: number) => [number, number, number];
  readonly schema_intoIPCStream: (a: number) => [number, number, number, number];
  readonly schema_metadata: (a: number) => [number, number, number];
  readonly schema_toFFI: (a: number) => [number, number, number];
  readonly schema_withMetadata: (a: number, b: any) => [number, number, number];
  readonly wasmMemory: () => any;
  readonly __wbg_ffistream_free: (a: number, b: number) => void;
  readonly ffistream_arrayAddr: (a: number, b: number) => number;
  readonly ffistream_arrayAddrs: (a: number) => [number, number];
  readonly ffistream_drop: (a: number) => void;
  readonly ffistream_numArrays: (a: number) => number;
  readonly ffistream_schemaAddr: (a: number) => number;
  readonly __wbg_table_free: (a: number, b: number) => void;
  readonly table_fromIPCStream: (a: number, b: number) => [number, number, number];
  readonly table_getArrayMemorySize: (a: number) => number;
  readonly table_intoFFI: (a: number) => [number, number, number];
  readonly table_intoIPCStream: (a: number) => [number, number, number, number];
  readonly table_numBatches: (a: number) => number;
  readonly table_recordBatch: (a: number, b: number) => number;
  readonly table_recordBatches: (a: number) => [number, number];
  readonly table_schema: (a: number) => number;
  readonly table_toFFI: (a: number) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly wasm_bindgen_63430e4767ca4913___convert__closures_____invoke______: (a: number, b: number) => void;
  readonly closure3491_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure3513_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
