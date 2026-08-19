import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import path from "node:path";

/**
 * Separate from vite.config.ts on purpose: the app config carries three
 * deploy-time plugins (config overlay, icon-font subsetting, brotli/gzip
 * precompression) that have no business running for a test process.
 */
export default defineConfig({
  // `hot: false`: solid-refresh has no HMR runtime under Vitest and its
  // injected `file:///@solid-refresh` import fails to resolve there.
  plugins: [solid({ hot: false })],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
    // vite-plugin-solid needs the browser/dev build of solid-js; without this
    // Vitest resolves the "node" condition and reactivity silently no-ops.
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
