import fs from "fs"
import path from "path"
import type { Plugin } from "vite"
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { subsetIconFont } from './scripts/subset-icon-font'
import { precompressDir } from './scripts/precompress-dist'

/**
 * Overlay a project-specific config directory (`configs/<slug>/`) on top of the
 * default configs in `public/`, selected by the `VITE_CONFIG_PROJECT` env var.
 *
 * Files present in `configs/<slug>/` fully replace their same-named counterparts
 * from `public/`; files the project omits fall back to the `public/` default. The
 * app's runtime `fetch("/<name>.json")` calls are unchanged — the correct files
 * are simply placed at the site root.
 *
 * - Dev: middleware serves a project file from disk if it exists, else falls through.
 * - Build: after Vite copies `public/` into the output dir, the project files are
 *   copied over the defaults.
 *
 * When `VITE_CONFIG_PROJECT` is unset, behaviour is unchanged (pure `public/`
 * defaults). A set-but-missing project directory aborts the build/dev server.
 *
 * One level of subdirectory is also served, which is what makes runtime config
 * variants possible: `configs/<slug>/2026/layers.json` is reachable at
 * `/2026/layers.json`, so two variants of the same file can coexist in one
 * build. See `src/config/variant.ts`. The depth limit is deliberate — variants
 * are the only use case, and walking arbitrarily deep would quietly turn the
 * whole project directory into a served tree.
 */
function configOverlay(project: string | undefined): Plugin {
  const configsRoot = path.resolve(__dirname, "configs")
  const projectDir = project ? path.join(configsRoot, project) : undefined

  function assertProjectExists() {
    if (!projectDir) return
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw new Error(
        `VITE_CONFIG_PROJECT="${project}" but config directory not found: ${projectDir}. ` +
          `Create configs/${project}/ or unset VITE_CONFIG_PROJECT.`,
      )
    }
  }

  /**
   * Files the project overrides, as paths relative to the project dir and
   * always with forward slashes, e.g. ["map.json", "2026/layers.json"] — the
   * form they take in a URL. Descends one level only (see the note above).
   */
  function overrideFiles(): string[] {
    if (!projectDir) return []
    const out: string[] = []
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        out.push(entry.name)
      } else if (entry.isDirectory()) {
        const sub = path.join(projectDir, entry.name)
        for (const child of fs.readdirSync(sub, { withFileTypes: true })) {
          if (child.isFile()) out.push(`${entry.name}/${child.name}`)
        }
      }
    }
    return out
  }

  let outDir = "dist"

  return {
    name: "config-overlay",
    configResolved(config) {
      outDir = config.build.outDir
      assertProjectExists()
      if (project) {
        config.logger.info(`config-overlay: using configs/${project}/ [${overrideFiles().join(", ")}]`)
      }
    },
    // Dev: serve project files from configs/<slug>/ when present.
    configureServer(server) {
      if (!projectDir) return
      const files = new Set(overrideFiles())
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        // Strip query string and leading slash to get the requested path,
        // relative to the project dir (e.g. "map.json", "2026/layers.json").
        const name = req.url.split("?")[0].replace(/^\/+/, "")
        // Membership in `files` is the security boundary as well as the lookup:
        // only paths this project actually contains are ever opened, so a
        // crafted "../" can never escape the project dir.
        if (!files.has(name)) return next()
        const filePath = path.join(projectDir, name)
        fs.readFile(filePath, (err, data) => {
          if (err) return next()
          if (name.endsWith(".json")) res.setHeader("Content-Type", "application/json")
          res.setHeader("Cache-Control", "no-cache")
          res.end(data)
        })
      })
    },
    // Build: copy project files over the defaults already emitted from public/.
    closeBundle() {
      if (!projectDir) return
      const targetDir = path.resolve(__dirname, outDir)
      for (const name of overrideFiles()) {
        const dest = path.join(targetDir, name)
        // A variant subdirectory has no counterpart in public/, so it does not
        // exist in the output yet — copyFileSync would throw ENOENT.
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(projectDir, name), dest)
      }
    },
  }
}

/**
 * After the bundle is written, precompress assets to .br (brotli q11) + .gz so
 * nginx serves them via brotli_static/gzip_static instead of compressing on the
 * fly at ~q5. Build-only; skipped in dev.
 */
function precompressDist(): Plugin {
  let outDir = "dist"
  return {
    name: "precompress-dist",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const { files, rawTotal, brTotal } = precompressDir(outDir)
      const kb = (n: number) => (n / 1024).toFixed(0)
      this.info?.(
        `precompress-dist: ${files} assets → brotli q11 ` +
          `(${kb(rawTotal)}KB → ${kb(brTotal)}KB) + gzip 9`,
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_")
  const project = env.VITE_CONFIG_PROJECT || undefined

  return {
    plugins: [solid(), tailwindcss(), configOverlay(project), subsetIconFont(__dirname), precompressDist()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        // Collaborative-annotation WebSocket — same-origin /collab in dev too
        // (mirrors the nginx proxy in production). Run the server first:
        //   cd collab-server && npm run dev
        "/collab": {
          target: "ws://localhost:5174",
          ws: true,
        },
        // Same-origin proxy to the Startanalyse tile/asset CDN, which serves
        // vector tiles with NO Access-Control-Allow-Origin header — a direct
        // cross-origin fetch() from MapLibre is blocked by CORS. Routing through
        // our own origin sidesteps CORS entirely. Mirrored by an nginx block in
        // production (server/setup_map_application.sh, gated to that project).
        // Inert for projects that never request /sa-tiles/ (e.g. woonzorglimburg
        // fetches tiles from a CORS-enabled host directly).
        "/sa-tiles": {
          target: "https://startanalyse2025.files.mapgallery.io",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/sa-tiles/, ""),
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // Split the heavy geo/vendor stacks into parallel-loadable, separately
          // cacheable chunks instead of one monolithic bundle.
          manualChunks(id: string) {
            // The parquet-wasm reader is vendored under src/vendor/ (slim build),
            // so match it before the node_modules early-return below.
            if (id.includes("vendor/parquet-wasm")) return "vendor-parquet"
            if (!id.includes("node_modules")) return
            if (id.includes("parquet-wasm")) return "vendor-parquet"
            if (id.includes("apache-arrow")) return "vendor-arrow"
            if (id.includes("maplibre")) return "vendor-maplibre"
            // Naming this chunk does not put it on the entry graph: what keeps
            // DuckDB out of the map bundle is that nothing imports
            // src/dashboard/duckdb-engine.ts statically.
            if (id.includes("@duckdb/duckdb-wasm")) return "vendor-duckdb"
          },
        },
      },
    },
  }
})
