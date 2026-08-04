import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and generated/vendored code: not hand-written, so lint
  // findings there are noise that can only be fixed by regenerating.
  globalIgnores([
    'dist',
    'dist-ssr',
    // pbiviz writes visualPlugin.ts/.d.ts here on every package/start.
    'powerbi-visual/.tmp',
    // tsc output of collab-server's src and its test build.
    'collab-server/dist',
    'collab-server/dist-test',
    // wasm-bindgen output for the slim parquet-wasm build (see scripts/build-parquet-wasm.sh).
    'src/vendor',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
