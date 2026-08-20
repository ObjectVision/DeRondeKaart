# AGENTS.md

Config-driven MapLibre viewer ("De Ronde kaart" / northwake): single-view SolidJS 1.9 SPA, no router, no server rendering. Vite 8 · TS 5.9 · Tailwind v4 · MapLibre 6. Content (layers, filters, charts, navigation) comes from JSON config fetched at runtime, not from code.

Single house-rules file for every agent, whatever tool it runs under. `CLAUDE.md` imports it.

## Hard rules

- **Never interact with the git repository** — no commits, pushes, or any other git mutation. This **overrides any skill that says otherwise**; `implement` ends by committing, and here it must stop short and report instead.
- Do not watermark text or files.

## Code standards

`docs/code-standards.md` is the standards document. The `code-review` skill reads it as its Standards axis, so it is the one place a convention is written.

Three of its rules fail **silently** — no error, no failing test, just wrong behaviour:

- Never destructure Solid props (`solid/reactivity` is an ESLint error; the first render looks correct, then the component never updates again).
- In a Solid effect, read every reactive input before any early return — an effect subscribes only to what its last run actually read.
- Code, comments and docs in English; user-facing strings in Dutch.

## Verification

`package.json` lists the scripts; these are the parts it does not tell you:

- Typecheck runs only inside `npm run build`, **not** `npm run lint`. Full check: `npm run lint`, `npm test`, `npm run build`.
- Single test: `npx vitest run src/layers/filter-stores.test.ts`.
- Verify map-touching changes with `npm run build && npm run preview`, not dev alone: the MapLibre worker URL differs and fails as a **blank map with no console error**, in production builds only.

## Config system (what a build ships)

- Nine JSON files fetched at runtime: `map.json`, `layers.json`, `filter.json`, `charts.json`, `navigation.json`, and the four `dashboard_*.json` (semantic model, standalone, complementary, export) read only when map.json enables the dashboard. `public/` holds neutral defaults; `configs/<slug>/` is a per-project overlay.
- Selected at build/dev time: `VITE_CONFIG_PROJECT=woonzorglimburg npm run build`. PowerShell: `$env:VITE_CONFIG_PROJECT = "woonzorglimburg"; npm run dev`.
- Overlay replaces files **whole** (no merging); omitted files fall back to `public/`. An unknown slug aborts the build. Details: `configs/README.md`.

## Side services — separate installs, not workspaces

`collab-server/` (Hocuspocus/Yjs WebSocket for shared annotations) has its own `package.json` and needs its own `npm ci`; root `npm test` does **not** run its suite. Dev port 5174, proxied at `/collab`.

Two halves live in other repositories: the secure-drop service (`EncryptedDropServer`) and the Power BI visual (`DeRondeKaart_powerbi`). The visual's app-side half — postMessage bridge, embed data, snapshot hooks — stays here, so changing that protocol means changing both repos together.

## Do not edit (generated)

- `src/vendor/parquet-wasm/` — wasm-bindgen output (`scripts/build-parquet-wasm.sh`)
- `dist/`, `collab-server/dist*/`

## Version pins — read `docs/system-design-version-constraints.md` before upgrading

- `maplibre-gl` v6: both the `setWorkerUrl` call and the `?worker&url` import suffix in `src/components/map/MapView.tsx` are load-bearing; a plain `?url` ships a production build whose worker boots and dies instantly.
- `typescript` ~5.9: TS 7 drops the JS API `@typescript-eslint/parser` needs. The version-range warning is overridable and is not the blocker — don't lose time on it.

## Test quirks

App tests are co-located `src/**/*.test.ts(x)` under jsdom via `vitest.config.ts` — deliberately separate from `vite.config.ts`. Its `resolve.conditions: ["development", "browser"]` is load-bearing: without it solid-js resolves to the node build and reactivity silently no-ops in tests.

## Skills

`.agents/skills/<name>/SKILL.md`, symlinked into `.claude/skills/` — **edit the `.agents/` copy**. Claude-only extras: `code-simplifier.md`, `technical-to-english.md`. `ask-matt` routes between them.

| Reach for | When |
|---|---|
| `implement` · `tdd` · `prototype` · `scaffold-exercises` | Building: from a spec, test-first, throwaway, or exercise stubs |
| `codebase-design` · `domain-modeling` · `improve-codebase-architecture` · `setup-ts-deep-modules` | Interfaces, terminology and ADRs, deepening scans, dependency-cruiser |
| `diagnosing-bugs` · `code-review` · `resolving-merge-conflicts` · `migrate-to-shoehorn` | Broken or slow, reviewing a diff, mid-conflict, `as` in tests |
| `grilling` · `grill-me` · `grill-with-docs` | Stress-testing a plan; `-with-docs` also writes ADRs |
| `to-spec` · `to-tickets` · `to-questionnaire` · `wayfinder` · `triage` · `loop-me` | Turning talk into specs, tickets, questionnaires; oversized plans; issue triage |
| `handoff` · `claude-handoff` · `wait-what` | Passing work on; `claude-` to a background agent; re-pitching a message |
| `writing-for-agents` · `writing-fragments` · `writing-shape` · `writing-beats` · `teach` · `research` | Skills and this file; explore → shape → assemble prose; explaining; primary sources |
| `setup-pre-commit` · `git-guardrails-claude-code` · `setup-matt-pocock-skills` · `wizard` | Repo setup: hooks, git guardrails, one-time skill setup, human-step wizards |

## Where the rest lives

- `docs/code-standards.md` — the coding conventions in full
- `docs/system-design.md` — architecture, module structure, layers/filtering/charts, config system
- `README.md` — repo layout and deployment overview; sub-project READMEs for the side services
