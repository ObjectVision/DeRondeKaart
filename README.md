# ![De Ronde kaart](public/logo.svg)

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](#license)
[![Built with SolidJS](https://img.shields.io/badge/built%20with-SolidJS-2c4f7c.svg)](https://www.solidjs.com)
[![Powered by MapLibre](https://img.shields.io/badge/powered%20by-MapLibre-295daa.svg)](https://maplibre.org)

De Ronde kaart is a performant open-source mapping application for the Web. Focused on transparant 
visualisation of geospatial models, its data, underlying mathematical relations and collaborative exploration.

## Getting started

```bash
npm install
npm run dev
```

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b` then `vite build` → `dist/` |
| `npm run lint` | ESLint. `solid/reactivity` is an **error** — see below |
| `npm test` | Vitest (filter stores, layer engine, overlay reactivity) |
| `npm run preview` | Serve a production build locally |

## Selecting a project configuration

A build bakes in one project's config overlay, chosen at build time:

```bash
VITE_CONFIG_PROJECT=woonzorglimburg npm run build
```

`configs/<project>/` is layered over the `public/` defaults; files are replaced
whole, and anything a project omits falls back to the default. Building with no
`VITE_CONFIG_PROJECT` produces a valid but content-free app. See
[configs/README.md](configs/README.md).

## Documentation

| | |
|---|---|
| [docs/system-design.md](docs/system-design.md) | Architecture, module structure, layers, filtering, charts, config system |
| [docs/system-design-styling.md](docs/system-design-styling.md) | Style spec |
| [docs/system-design-collaboration.md](docs/system-design-collaboration.md) | Shared annotations (Yjs / Hocuspocus) |
| [docs/system-design-version-constraints.md](docs/system-design-version-constraints.md) | Why certain versions are pinned |
| [docs/preprocessing-pipeline.md](docs/preprocessing-pipeline.md) | Turning source data into the served formats |
| [server/README.md](server/README.md) | VM provisioning and deployment |

## Deployment

`vite build` emits a static `dist/` — hashed assets under `assets/`, plus `.br`
and `.gz` siblings for nginx `brotli_static`/`gzip_static`. It is served as
plain static files behind nginx.

Provisioning and the GitHub-webhook deploy live in
[server/setup_map_application.md](server/setup_map_application.md). A
`Dockerfile` and `docker-compose.yml` cover the container route.

## License

De Ronde kaart is free and open source software.
All code in this repository is licensed under the GNU Affero General Public License, Version 3.0
([LICENSE](LICENSE) or [https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)).

The map data, tiles and per-project configuration a deployment serves are **not** part of this
software and are not covered by this license. They carry whatever terms their publisher sets —
see the relevant `configs/<project>/` overlay and the layer metainfo for attribution.

Third-party dependencies keep their own licenses; run `npm ls --all` or read `package-lock.json`
for the resolved set.