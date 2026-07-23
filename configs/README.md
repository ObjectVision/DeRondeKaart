# Per-project configuration

The map application is specified by five JSON files fetched at runtime from the site root:

- `map.json` — map view, controls, feature flags
- `layers.json` — data layers
- `filter.json` — area filters
- `charts.json` — chart definitions
- `navigation.json` — navigation tree

## Defaults vs. overrides

- **Defaults** live in [`../public/`](../public/) and ship when no project is selected.
  They are intentionally neutral (Netherlands-centered map, empty layers/navigation/etc.),
  so a plain build produces a valid but content-free app.
- **Project overrides** live in `configs/<project>/`. Each directory holds the config files
  that project wants to change. **Files are replaced whole** — a project supplies a complete
  file, not a partial patch. Any file a project omits falls back to the `public/` default.

The app code and its `fetch("/<name>.json")` calls never change; the overlay just decides
which files end up at the site root.

## Selecting a project

Selection happens at **build time** via the `VITE_CONFIG_PROJECT` env var:

```bash
# Build the woonzorglimburg config
VITE_CONFIG_PROJECT=woonzorglimburg npm run build

# Run the dev server with that config
VITE_CONFIG_PROJECT=woonzorglimburg npm run dev
$env:VITE_CONFIG_PROJECT = "woonzorglimburg"; npm run dev

# Build the public/ defaults (no overlay)
npm run build
```

If `VITE_CONFIG_PROJECT` names a directory that does not exist under `configs/`, the build
aborts with an error — a typo can never silently ship the defaults.

In deployment the var is set per instance:

- **rsync deploy** — pass `--config-project <slug>` to `server/setup_map_application.sh`;
  it bakes `VITE_CONFIG_PROJECT` into the generated deploy script.
- **Docker** — pass `--build-arg CONFIG_PROJECT=<slug>` (or set `CONFIG_PROJECT` for
  `docker compose build`).

## Adding a new project

1. Create `configs/<project>/`.
2. Add only the config files you want to override (copy a `public/` default or an existing
   project's file as a starting point). Omit the rest to inherit the defaults.
3. Build/deploy with `VITE_CONFIG_PROJECT=<project>`.

## Existing projects

- `woonzorglimburg/` — the Limburg deployment (`map.woonzorglimburg.nl`). Overrides all five
  config files.
