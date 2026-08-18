# De Ronde kaart

An open-source web map application for geospatial data, focused on transparent
visualisation, clear styling and thorough metainfo while staying fast.

It is a config-driven MapLibre viewer: a single-view client-side SPA with no
router and no server rendering. What a deployment shows — layers, filters,
charts, navigation tree, feature flags — comes from five JSON files fetched at
runtime, not from the code. One codebase serves every project.

**Stack:** SolidJS 1.9 · MapLibre GL JS 6 · Vite 8 · TypeScript 5.9 · Tailwind v4.
Data arrives as PMTiles, MVT, Cloud-Optimized GeoTIFF, FlatGeobuf or GeoJSON,
with Parquet attribute sidecars decoded to Apache Arrow in a WebAssembly worker.

## Getting started

```bash
npm ci
npm run dev
```

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b` then `vite build` → `dist/` |
| `npm run lint` | ESLint. `solid/reactivity` is an **error** — see below |
| `npm test` | Vitest (filter stores, layer engine, overlay reactivity) |
| `npm run preview` | Serve a production build locally |

Requires Node `^20.19.0 || >=22.12.0` (the floor Vite and Rolldown set).

Some behaviour differs between dev and a production build — the MapLibre worker
URL in particular. Check `npm run build && npm run preview` before trusting a
change that touches the map.

## Selecting a project configuration

A build bakes in one project's config overlay, chosen at build time:

```bash
VITE_CONFIG_PROJECT=woonzorglimburg npm run build
```

`configs/<project>/` is layered over the `public/` defaults; files are replaced
whole, and anything a project omits falls back to the default. Building with no
`VITE_CONFIG_PROJECT` produces a valid but content-free app. See
[configs/README.md](configs/README.md).

## Working on the code

[CLAUDE.md](CLAUDE.md) holds the house conventions. The one that bites hardest:

> **Never destructure props.** Solid props are getters — destructuring reads each
> one once, outside any tracking scope, and the component then silently never
> updates again.

The same hazard has a runtime-only cousin that no linter catches: a Solid effect
subscribes to *what it actually read on its last run*, so an early `return` above
an accessor read silently unsubscribes the effect from it. Read your reactive
inputs before any guard that can bail out.

## Documentation

| | |
|---|---|
| [docs/system-design.md](docs/system-design.md) | Architecture, module structure, layers, filtering, charts, config system |
| [docs/system-design-styling.md](docs/system-design-styling.md) | GeoStyler → MapLibre paint translation |
| [docs/system-design-collaboration.md](docs/system-design-collaboration.md) | Shared annotations (Yjs / Hocuspocus) |
| [docs/system-design-power-bi.md](docs/system-design-power-bi.md) | Power BI visual and the postMessage bridge |
| [docs/system-design-version-constraints.md](docs/system-design-version-constraints.md) | Why certain versions are pinned |
| [docs/preprocessing-pipeline.md](docs/preprocessing-pipeline.md) | Turning source data into the served formats |
| [server/README.md](server/README.md) | VM provisioning and deployment |

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The application |
| `public/` · `configs/` | Default config files, and per-project overlays |
| `scripts/` | Build-time tooling (icon-font subsetting, asset precompression) |
| `server/` | Bash provisioning for nginx, deploy webhooks and the side services |
| `collab-server/` · `drop-server/` | Standalone Node services, each with its own tests |
| `powerbi-visual/` | Power BI custom visual embedding the app |
| `data/` | Python preprocessing scripts |
| `deploy/` | nginx config for the container image |

## Deployment

`vite build` emits a static `dist/` — hashed assets under `assets/`, plus `.br`
and `.gz` siblings for nginx `brotli_static`/`gzip_static`. It is served as
plain static files behind nginx.

Provisioning and the GitHub-webhook deploy live in
[server/setup_map_application.md](server/setup_map_application.md). A
`Dockerfile` and `docker-compose.yml` cover the container route.
