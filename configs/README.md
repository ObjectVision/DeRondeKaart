# Per-project configuration

The map application is specified by nine JSON files fetched at runtime from the site root:

- `map.json` — map view, controls, feature flags
- `layers.json` — data layers
- `filter.json` — area filters
- `charts.json` — chart definitions
- `navigation.json` — navigation tree
- `dashboard_semantic_model.json` — dashboard tables, relationships, measures
- `dashboard_standalone.json` — standalone dashboard layout
- `dashboard_complementary.json` — in-map area comparison
- `dashboard_export.json` — dashboard print/PDF layout

The four `dashboard_*` files are only read when `map.json` enables the dashboard.

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

In deployment the var is set per instance: pass `--config-project <slug>` to
`server/setup_map_application.sh`, which bakes `VITE_CONFIG_PROJECT` into the
generated deploy script.

## `map.json`: the starting basemap

`map.json` may name the background map a fresh session opens on:

```json
"basemap": "kleur-labels-only"
```

Omit it to use the app default (`kleur-labels`). An unknown id logs a warning and falls back
to that default, so a typo degrades quietly rather than leaving the map unstyled — check the
console after changing it.

The ids are **not** derived from the picker's checkboxes, and the obvious guess is wrong:
`kleur-labels` predates the two-checkbox UI and still means labels **and** roads/water.
Labels on their own are `-labels-only`.

| id | Labels | Wegen en water op voorgrond |
|---|---|---|
| `luchtfoto` | — | *(not offered)* |
| `luchtfoto-labels` | ✓ | *(not offered)* |
| `kleur` | — | — |
| `kleur-labels` | ✓ | ✓ |
| `kleur-labels-only` | ✓ | — |
| `kleur-wegen` | — | ✓ |
| `grijs` | — | — |
| `grijs-labels` | ✓ | ✓ |
| `grijs-labels-only` | ✓ | — |
| `grijs-wegen` | — | ✓ |

The table in `src/components/map/map-view-config.ts` (`BASEMAPS`) is the source of truth.

This value only **seeds** a session: a basemap the user picks is remembered in
`sessionStorage` and wins on reload, and a basemap in a share URL wins over both.

## `map.json`: the pick layer

`map.json` may name one layer that is added to the left map at startup, so a click anywhere
has a feature to hit before the user has added anything:

```json
"pickLayer": "buurt_klik"
```

The value is a layer **id** from `layers.json`; an id that matches nothing logs a warning and
leaves the map with nothing to click. The layer is added like any other, so it is replayed
after a basemap swap and takes part in feature picking — it is not a side channel.

The named layer has to be declared for this job. The `buurt_klik` pattern in
`startanalyse2026/` is the reference: invisible polygons (`"style": { "opacity": 0 }`) that
are `excludeFromLegend` and `excludeFromComparison`, plus **`highlightable: true`** — without
that flag the source gets no `promoteId`, its features carry no id, and nothing highlights.
`highlightable` also requires an `mvt`/`pmtiles` format, since only vector tiles have stable
feature ids.

Highlight appearance defaults to a **red outline over a white casing**, so the common case
needs no styling at all. `highlightcolor` overrides the outline and `highlightcasing` the
casing (`true` for the defaults, or `{ "color", "width" }`); a casing narrower than the
outline is refused with a warning, since it would paint nothing.

`pickLayer` is unrelated to the dashboard's selection layer below, though one layer can serve
both — that additionally needs `compareSelectable`.

## `map.json`: the dashboard

`map.json` decides which dashboard modes a project offers:

```json
"dashboard": "both"
```

| value | `?mode=dashboard` | Comparison in the map |
|---|---|---|
| `"off"` *(default)* | — | — |
| `"standalone"` | ✓ | — |
| `"complementary"` | — | ✓ |
| `"both"` | ✓ | ✓ |

The capability wins over the URL: `?mode=dashboard` on a project that does not offer the
standalone mode logs a warning and opens the map, so a link shared into the wrong project
degrades rather than erroring.

`"complementary"` additionally needs a **selection layer** in `layers.json` carrying both
`highlightable` and `compareSelectable` (the `buurt_klik` pattern: invisible polygons,
excluded from legend and comparison). It has to be declared there rather than in
`dashboard_complementary.json` because feature ids come from `promoteId`, which MapLibre only
accepts when the source is created. `dashboard_complementary.json` then names which layer
serves gemeente, which serves buurt, and the zoom at which clicking switches between them.

Enabling it means the four `dashboard_*.json` files have to say something — the neutral
defaults in `public/` describe an empty dashboard. `dashboard_semantic_model.json` names its
own parquet URLs, so the standalone dashboard works in a project with no map layers at all;
the files are only fetched when the dashboard actually opens.

## Adding a new project

1. Create `configs/<project>/`.
2. Add only the config files you want to override (copy a `public/` default or an existing
   project's file as a starting point). Omit the rest to inherit the defaults.
3. Build/deploy with `VITE_CONFIG_PROJECT=<project>`.

## Existing projects

- `woonzorglimburg/` — the Limburg deployment (`map.woonzorglimburg.nl`). Overrides all five
  config files.
