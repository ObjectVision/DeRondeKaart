import js from '@eslint/js'
import globals from 'globals'
import solid from 'eslint-plugin-solid/configs/typescript'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and generated/vendored code: not hand-written, so lint
  // findings there are noise that can only be fixed by regenerating.
  globalIgnores([
    'dist',
    'dist-ssr',
    // tsc output of collab-server's src and its test build.
    'collab-server/dist',
    'collab-server/dist-test',
    // tsc output of drop-server's src and its test build.
    'drop-server/dist',
    'drop-server/dist-test',
    // wasm-bindgen output for the slim parquet-wasm build (see scripts/build-parquet-wasm.sh).
    'src/vendor',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      solid,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Solid props are getters: destructuring one reads it once, outside any
      // tracking scope, and the component then never updates. That failure is
      // silent — the first render looks correct — so this is an error, not a
      // style warning. It is the main automated guard for the whole port.
      'solid/reactivity': 'error',
      // Solid binds element refs by ASSIGNING the variable named in `ref={x}`,
      // which the compiler emits — the source only ever declares `let x!: T`.
      // This rule sees the declaration without an assignment and flags every
      // ref in the codebase, so it is structurally incompatible with the
      // framework rather than catching anything real here.
      'no-unassigned-vars': 'off',
    },
  },
])
