import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy geo/vendor stacks into parallel-loadable, separately
        // cacheable chunks instead of one monolithic bundle.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("parquet-wasm") || id.includes("geoparquet-wasm")) {
            return "vendor-parquet";
          }
          if (id.includes("apache-arrow")) return "vendor-arrow";
          if (id.includes("deck.gl")) return "vendor-deck";
          if (id.includes("maplibre") || id.includes("react-map-gl")) {
            return "vendor-maplibre";
          }
        },
      },
    },
  },
})
