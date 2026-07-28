// Precompress build assets to .br (brotli q11) and .gz (gzip 9) so nginx can
// serve them via brotli_static/gzip_static instead of compressing on the fly.
//
// nginx's runtime brotli filter is limited to ~level 5 (q11 is too CPU-heavy
// per request); emitting q11 files at build time gives ~13% smaller transfer
// for free. Uses Node's built-in zlib — no dependency.
//
// Invoked from the vite build (see the precompressDist plugin in vite.config.ts).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Only text/wasm assets benefit; woff2/png/jpg/webp are already compressed.
const COMPRESSIBLE = new Set([".js", ".css", ".wasm", ".json", ".svg", ".map", ".html"]);
const MIN_BYTES = 1024; // don't bother with tiny files

function brotli(buf: Buffer): Buffer {
  return zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
}

function gzip(buf: Buffer): Buffer {
  return zlib.gzipSync(buf, { level: 9 });
}

export interface PrecompressSummary {
  files: number;
  rawTotal: number;
  brTotal: number;
}

/** Recursively precompress every eligible file under `dir`. */
export function precompressDir(dir: string): PrecompressSummary {
  let files = 0;
  let rawTotal = 0;
  let brTotal = 0;

  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      // Skip anything already compressed (including our own outputs on re-run).
      if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
      if (!COMPRESSIBLE.has(path.extname(entry.name))) continue;

      const buf = fs.readFileSync(p);
      if (buf.length < MIN_BYTES) continue;

      const br = brotli(buf);
      const gz = gzip(buf);
      // Only emit if actually smaller than the original.
      if (br.length < buf.length) fs.writeFileSync(p + ".br", br);
      if (gz.length < buf.length) fs.writeFileSync(p + ".gz", gz);

      files += 1;
      rawTotal += buf.length;
      brTotal += Math.min(br.length, buf.length);
    }
  };

  if (fs.existsSync(dir)) walk(dir);
  return { files, rawTotal, brTotal };
}
