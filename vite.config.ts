import fs from "fs"
import path from "path"
import type { Plugin } from "vite"
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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

  /** Files (basenames) the project overrides, e.g. ["map.json", "navigation.json"]. */
  function overrideFiles(): string[] {
    if (!projectDir) return []
    return fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
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
        // Strip query string and leading slash to get the requested basename.
        const name = req.url.split("?")[0].replace(/^\/+/, "")
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
        fs.copyFileSync(path.join(projectDir, name), path.join(targetDir, name))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_")
  const project = env.VITE_CONFIG_PROJECT || undefined

  return {
    plugins: [react(), tailwindcss(), configOverlay(project)],
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
            if (!id.includes("node_modules")) return
            if (id.includes("parquet-wasm") || id.includes("geoparquet-wasm")) {
              return "vendor-parquet"
            }
            if (id.includes("apache-arrow")) return "vendor-arrow"
            if (id.includes("deck.gl")) return "vendor-deck"
            if (id.includes("maplibre") || id.includes("react-map-gl")) {
              return "vendor-maplibre"
            }
          },
        },
      },
    },
  }
})
