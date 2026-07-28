#!/usr/bin/env bash
# Reproducibly build the SLIM parquet-wasm the app vendors in src/vendor/parquet-wasm/.
#
# The npm `parquet-wasm` ships a kitchen-sink WASM (all codecs + reader + writer, ~6.3 MB raw /
# ~1.5 MB brotli). The app only READS, and every served .parquet is UNCOMPRESSED or SNAPPY, so we
# build reader + async (for readParquetStream range streaming) + snappy only → ~4.4 MB raw /
# ~0.82 MB brotli, saving ~709 KB off every cold load.
#
# Run this manually only when bumping the parquet-wasm version (rare); the committed artifact under
# src/vendor/parquet-wasm/ is what ships. Requires: rustup, cargo >= 1.85 (edition2024), wasm-pack.
#
# Usage:  scripts/build-parquet-wasm.sh [version]     (default version below)
set -euo pipefail

VERSION="${1:-0.7.1}"
REPO_URL="https://github.com/kylebarron/parquet-wasm"
FEATURES="reader,async,snappy"   # async is required by readParquetStream

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$here/src/vendor/parquet-wasm"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Building slim parquet-wasm v$VERSION (features: $FEATURES) ..."
git clone --depth 1 --branch "v$VERSION" "$REPO_URL" "$work/parquet-wasm"
cd "$work/parquet-wasm"

rustup target add wasm32-unknown-unknown
# NOTE: --out-dir must precede the cargo feature flags for current wasm-pack.
wasm-pack build --release --target web --out-dir pkg-slim \
  --no-default-features --features "$FEATURES"

mkdir -p "$dest"
# web target emits 4 files (glue is inlined into parquet_wasm.js — no separate _bg.js).
for f in parquet_wasm.js parquet_wasm_bg.wasm parquet_wasm.d.ts parquet_wasm_bg.wasm.d.ts; do
  cp "pkg-slim/$f" "$dest/$f"
done

echo "Vendored slim parquet-wasm into $dest:"
ls -la "$dest"
echo "Done. Commit the updated files under src/vendor/parquet-wasm/."
