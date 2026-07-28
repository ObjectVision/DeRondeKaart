# Vendored slim `parquet-wasm`

A reader-only, snappy-only build of [parquet-wasm](https://github.com/kylebarron/parquet-wasm)
(v0.7.1), replacing the npm package to save ~709 KB brotli off every cold load.

- Built with `--target web --no-default-features --features reader,async,snappy`.
  - `reader` + `async` → `readParquet` and `readParquetStream` (the range-streaming path).
  - `snappy` → decodes the served files; UNCOMPRESSED needs no codec feature.
  - Writer + brotli/gzip/zstd/lz4 codecs are dropped (unused by the app).
- **Constraint:** every served `.parquet` must be UNCOMPRESSED or SNAPPY. A file using another
  codec (zstd/gzip/…) will fail to read here. Keep data producers on snappy/uncompressed.
- Imported by [../../layers/parquet-loader.ts](../../layers/parquet-loader.ts).

**Do not hand-edit these files.** Regenerate on a version bump with
[`scripts/build-parquet-wasm.sh`](../../../scripts/build-parquet-wasm.sh) and commit the result.

Files (wasm-pack `web` target): `parquet_wasm.js` (glue + default `initParquet`),
`parquet_wasm_bg.wasm`, and the two `.d.ts` type files.
