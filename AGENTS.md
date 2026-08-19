# AGENTS.md

Config-driven MapLibre viewer ("De Ronde kaart" / northwake): single-view SolidJS 1.9 SPA, no router, no server rendering. Vite 8 · TS 5.9 · Tailwind v4 · MapLibre 6. Content (layers, filters, charts, navigation) comes from JSON config fetched at runtime, not from code.

## Hard rules

- Do not interact with the git repository (no commits, pushes, or any other git mutations).
- Do not watermark text or files.
- `CLAUDE.md` is the house style file — follow it. The rules that fail **silently**:
  - Never destructure Solid props (`solid/reactivity` is an ESLint error; the first render looks correct, then the component never updates again).
  - In a Solid effect, read every reactive input before any early return — an effect subscribes only to what its last run actually read.
  - Code, comments and docs in English; user-facing strings in Dutch.

## Commands (repo root)

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b` then `vite build` → `dist/` |
| `npm run lint` | ESLint over all TS/TSX, including the side servers' `src/` |
| `npm test` | Vitest |
| `npm run preview` | Serve the production build |

- Single test: `npx vitest run src/layers/filter-stores.test.ts`
- Full verification: `npm run lint`, `npm test`, `npm run build` (typecheck runs only inside `build`, not `lint`).
- Requires Node `^20.19 || >=22.12`.
- Verify map-touching changes with `npm run build && npm run preview`, not just dev: the MapLibre worker URL differs between them and fails as a **blank map with no console error**, one variant only in production builds.

## Config system (what a build ships)

- Nine JSON files fetched at runtime: `map.json`, `layers.json`, `filter.json`, `charts.json`, `navigation.json`, and the four `dashboard_*.json` (semantic model, standalone, complementary, export) read only when map.json enables the dashboard. `public/` holds neutral defaults; `configs/<slug>/` is a per-project overlay.
- Selected at build/dev time: `VITE_CONFIG_PROJECT=woonzorglimburg npm run build`. PowerShell: `$env:VITE_CONFIG_PROJECT = "woonzorglimburg"; npm run dev`.
- Overlay replaces files **whole** (no merging); omitted files fall back to `public/`. An unknown slug aborts the build. Details: `configs/README.md`.

## Side services — separate installs, not workspaces

Each has its own `package.json` and needs its own `npm ci`. Root `npm test` does **not** run their suites.

| Dir | What | Run / test |
|---|---|---|
| `collab-server/` | Hocuspocus (Yjs) WebSocket for shared annotations | `npm run dev` (port 5174; the Vite dev server proxies `/collab` to it). `npm test` = `tsc` to `dist-test/` + `node --test` |
| `drop-server/` | E2E-encrypted upload-only drop service | Same test pattern. `npm run page:vendor` populates the gitignored `page/vendor/` with libsodium |
| `powerbi-visual/` | Power BI custom visual embedding the app via postMessage | `npm run package` (pbiviz) |

## Do not edit (generated)

- `src/vendor/parquet-wasm/` — wasm-bindgen output (`scripts/build-parquet-wasm.sh`)
- `dist/`, `collab-server/dist*/`, `drop-server/dist*/`, `powerbi-visual/.tmp/`

## Version pins — read `docs/system-design-version-constraints.md` before upgrading

- `maplibre-gl` v6: both the `setWorkerUrl` call and the `?worker&url` import suffix in `src/components/map/MapView.tsx` are load-bearing; a plain `?url` ships a production build whose worker boots and dies instantly.
- `typescript` ~5.9: TS 7 drops the JS API `@typescript-eslint/parser` needs. The version-range warning is overridable and is not the blocker — don't lose time on it.

## Test quirks

- App tests are co-located `src/**/*.test.ts(x)` under jsdom via `vitest.config.ts` — deliberately separate from `vite.config.ts`. Its `resolve.conditions: ["development", "browser"]` is load-bearing: without it solid-js resolves to the node build and reactivity silently no-ops in tests.

## Where the rest lives

- `docs/system-design.md` — architecture, module structure, layers/filtering/charts, config system
- `README.md` — repo layout and deployment overview; sub-project READMEs for the side services
