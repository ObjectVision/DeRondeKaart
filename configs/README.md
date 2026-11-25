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

### Location info: `featureinfo.locationinfo`

woonzorglimburg's pick layer `pc6_klik` answers with the "Locatie informatie" window rather
than the Details popup. Its tiles carry only `pc6` and `row`; everything shown comes from one
row of a parquet sidecar, read over HTTP range requests:

```json
"featureinfo": {
  "locationinfo": {
    "source": "https://data.woonzorglimburg.nl/parquet/pc6_locatieinfo_2026.parquet?v=…",
    "rowField": "row",
    "keyField": "pc6",
    "templateUrl": "https://data.woonzorglimburg.nl/meta/locatieinfo/locatie-informatie.html?v=…"
  }
}
```

- `rowField` (default `row`) is the 0-based row index in `source`. **The PMTiles and the
  parquet are a matched pair**: rebuild, upload and version-stamp them together. `keyField`
  is the guard — when the row's value differs from the feature's, the window shows an error
  instead of another area's data.
- Unlike `buurt_klik`, `pc6_klik` is deliberately **not** `highlightable`: the clicked
  postcode gets no outline, so the pick layer stays silent. For debugging, add
  `"highlightable": true, "idProperty": "row"` locally — the id is needed because neither
  `row` nor `pc6` is one the loader guesses.
- Precedence: `pbl` › `locationinfo` › `template`/`templateUrl`. Other projects are
  untouched; startanalyse2026's `buurt_klik` keeps its PBL summary.
- The template format (tabs, `[[ field | format ]]`, pie/distance/sparkline widgets) and the
  build steps are in [`data/locatieinfo/README.md`](../data/locatieinfo/README.md).

## `map.json`: the location search

The `mapControls` block decides whether the search box appears and which geocoder answers it:

```json
"mapControls": {
  "search": true,
  "zoom": false,
  "searchProvider": "pdok",
  "searchFilter": "provincienaam:\"Limburg\""
}
```

Two backends, and **each narrowing option applies to exactly one of them**:

| key | provider | effect |
|---|---|---|
| `searchProvider` | — | `"nominatim"` (worldwide, the default) or `"pdok"` (PDOK Locatieserver, NL only) |
| `searchCountries` | `nominatim` | ISO 3166-1 alpha-2 codes, e.g. `["nl"]`. Ignored under `pdok`, which is already NL-only |
| `searchFilter` | `pdok` | a Solr filter query passed through as `fq`. Ignored under `nominatim`, which takes no filter |

Both narrowing options default to empty, meaning no restriction.

### `searchFilter`

Any indexed Locatieserver field works, with ordinary Solr syntax:

```
provincienaam:"Limburg"
gemeentenaam:("Venlo" OR "Roermond")
woonplaatsnaam:"Maastricht"
```

It is a **strict** filter: with `provincienaam:"Limburg"`, only Limburg records come back.
Searching "Groningen" then yields *Groningenstraat, Heerlen* rather than the city — the filter
never widens to rescue a query. That is the point: PDOK already ranks "Bergen" as Bergen (L)
first, but without the filter it still offers Bergen (NH) and Bergen op Zoom underneath.

**The string is passed through verbatim and cannot be validated.** Only its type is checked;
a blank value means "no filter". PDOK answers an unknown field, a misspelled value or a
malformed clause with an *empty result set* rather than an error, so a mistake reaches users
as a search box that finds nothing, with no warning anywhere. Three ways to get it wrong:

- **Quote any value with a space or hyphen.** `provincienaam` is an analysed field, so bare
  `Noord-Holland` is tokenised and over-matches wildly — 46 656 hits against 9 787 for the
  quoted form.
- **Use PDOK's own spellings.** The northern province is `Fryslân`; `"Friesland"` matches
  nothing.
- **Use a field PDOK indexes.** Anything else is simply never true.

Check a filter against the API before shipping it:

```
curl -G 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest'   --data-urlencode 'q=Bergen'   --data-urlencode 'fq=provincienaam:"Limburg"' -d 'rows=5&fl=weergavenaam,type'
```

One thing the app does for you: PDOK's default `fq` is
`type:(gemeente OR woonplaats OR weg OR postcode OR adres)`, and sending any `fq` **replaces**
it rather than adding to it — leaving `perceel`, `wijk` and `buurt` records free to appear.
So the app sends that default alongside your filter. If your filter names `type:` itself, it
is sent alone, so `type:perceel` does what it says.

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

## Config variants (multiple datasets in one build)

A project can ship several **variants** of the same map — typically model years —
and switch between them at runtime without reloading the app. Only
`layers.json` and `navigation.json` differ per variant; `map.json`,
`filter.json` and `charts.json` are shared.

Put each variant's two files in a subdirectory named after the variant id, and
declare the variants in `map.json`:

```
configs/startanalyse2026/
  map.json          <- shared, declares the variants
  filter.json       <- shared
  charts.json       <- shared
  2025/
    layers.json
    navigation.json
  2026/
    layers.json
    navigation.json
  2025_2026/
    layers.json
    navigation.json
```

```json
"variants": {
  "default": "2026",
  "items": [
    { "id": "2025", "label": "Startanalyse 2025" },
    { "id": "2026", "label": "Startanalyse 2026" },
    { "id": "2025_2026", "label": "Vergelijk 2025 / 2026" }
  ]
}
```

The subdirectory is served at a matching URL prefix (`/2026/layers.json`), so
both variants ship in one build. Only **one** level of nesting is served.

Omit the `variants` block and everything behaves as it always has — the config
files stay at the site root. Ids must match `[A-Za-z0-9_-]+` because they become
URL path segments; a malformed block logs a warning and disables variants rather
than breaking the boot.

### Switching at runtime

There is no in-app control: the switch is driven from outside, so a host page
embedding the map in an iframe stays in charge of which dataset is shown.

```js
// from the embedding page
mapFrame.contentWindow.postMessage({ type: "set-variant", id: "2026" }, "*");
```

`set-variant` clears every layer on both maps. To change only *which* layer is
shown (another year, another scenario) use `map-command`, which edits the layer
stack in place:

```js
mapFrame.contentWindow.postMessage({
  type: "map-command",
  commands: [
    // Swap without a gap: the old layer stays underneath until the new one has
    // drawn (map idle), then it is removed. Needs `map-ready` v >= 2.
    { cmd: "replace", map: "a", layer: "nl2120_bau1_landgebruik_2120", replaces: "nl2120_bau1_landgebruik_basisjaar" },
    { cmd: "add", map: "b", layer: "nl2120_nbsgenuanceerd_landgebruik_2120" },
    { cmd: "remove", map: "b", layer: "nl2120_bau2_landgebruik_2120" },
  ],
}, "*");
```

A plain `remove` + `add` shows the basemap for a moment: `add` returns before
any tile has loaded. The map announces itself with `{ type: "map-ready", v }`;
`v: 2` and up understands `replace`.

A `variant` URL parameter does the same for deep links (`?variant=2026`), and is
also read from the share-link hash. Share links **carry the active variant
automatically** — necessary because layer ids are reused between variants, so a
link without it would reopen the same ids against a different year's data.

Switching removes every layer the user added from both maps. The basemap, the
`studyarea` layer (unless the variant names its own, below), the `pickLayer` and
the current view all survive. That the
added layers go is deliberate rather than a limitation: with ids reused across
variants, keeping them would silently repoint each layer at another year.

### Per-variant boot flags

A variant item may override `text_to_tool`, `speech_to_text`, `center` and
`zoom` (and `studyarea`, below) — the only `map.json` keys that can differ per
variant:

```json
{ "id": "ontwikkel", "label": "Ontwikkel", "text_to_tool": true, "speech_to_text": true }
```

They decide which models load, so they are resolved once, for the variant the
page **opens** in (`?variant=`, else `default`). A later `set-variant` or a share
link's hash does not re-evaluate them. An override is held to the same rules as
the root value: speech still needs `text_to_tool`, and both still need their
`modelUrls`.

`center` / `zoom` set the view a page opens on, so a variant host lands on its
own region (objectvision's `wonenenzorgopdekaart` opens over Kennemerland):

```json
{ "id": "wonenenzorgopdekaart", "center": [4.61479, 52.41961], "zoom": 11.05 }
```

Either may be given alone; the other then comes from the root. Like the flags
they apply to the opening variant only — a later switch leaves the camera where
it is — and a share link's `#zoom=&center=` still wins over both.

### Study area per variant

A variant item may name its own `studyarea`: the id of a layer in **that**
variant's `layers.json`. Variants without one use the root `studyarea`:

```json
{ "id": "wonenenzorgopdekaart", "label": "Wonen en zorg op de kaart",
  "studyarea": "wzw_studiegebied" }
```

Unlike the boot flags this one is **runtime**: it follows the active variant, so
a `set-variant` swaps the mask. An id the active variant's `layers.json` lacks
only warns in the console and shows no mask.

### Pick layer per variant

A variant item may likewise name its own `pickLayer`, overriding the root one.
It is also **runtime**: a switch removes the old variant's pick layer with
everything else and adds this variant's once its `layers.json` is in.
objectvision has no root `pickLayer`, so only `wonenenzorgopdekaart` answers clicks
on empty map, with its wijk-informatie window (`wijk_klik`, see
[`data/locatieinfo/README.md`](../data/locatieinfo/README.md)):

```json
{ "id": "wonenenzorgopdekaart", "studyarea": "wzw_studiegebied", "pickLayer": "wijk_klik" }
```

### Host per variant

A variant may list `hosts`: extra domains, served by the **same** map site, that
open that variant while the address bar keeps the domain (no redirect):

```json
{ "id": "wonenenzorgopdekaart", "label": "Wonen en zorg op de kaart",
  "hosts": ["wonenenzorgopdekaart.derondekaart.nl"] }
```

The variant a page opens in is `?variant=`, else the variant listing this
hostname, else `default`, else the first item. The other variants stay reachable
through the switcher and `?variant=`. A hostname claimed by two variants warns and
goes to the first.

The config is only half of it; per domain:

1. A DNS A (and AAAA) record pointing at the map server.
2. The domain added to the map site's `server_name` and certificate —
   `setup_map_application.sh --extra-host <domain>`, or by hand on a live site
   (`server_name` in both blocks, then
   `certbot --nginx --expand --cert-name <host> -d <host> -d <domain>`).
3. Every data host that allows CORS for named origins only (not `*`) must also
   allow `https://<domain>`, or that variant's layers stay blank there.

## Remote config (`?config=`)

A deployed map can load its config from another https folder instead of its own
origin — typically a GitHub repository, served by `raw.githubusercontent.com`
(which sends `Access-Control-Allow-Origin: *`). A project then needs new JSON, not
a new build:

```
https://map.derondekaart.nl/?config=https://raw.githubusercontent.com/<org>/<repo>/<branch>[/<subfolder>]&variant=<id>
```

The folder has the same shape as `configs/<project>/`:

```
map.json                  required; replaces the built one (variants, studyarea, basemap, …)
<variant>/layers.json     required, per variant (at the root when map.json has no "variants")
<variant>/navigation.json
filter.json, charts.json  optional
dashboard_*.json          only when map.json enables the dashboard
```

There is **no fallback** to the built files: a file missing from the remote folder
behaves as missing (optional ones warn and switch their feature off; `layers.json`
and `navigation.json` fail loudly).

**The folder must be allowlisted** in `configSources` of the **built** `map.json`:

```json
"configSources": ["https://raw.githubusercontent.com/ObjectVision/test_remote_rondekaart_config/"]
```

An entry admits itself and everything under it (`/`-bounded, so `…/repo` does not
admit `…/repo-evil`); only `https:` folders without query or credentials qualify. A
`?config=` that does not match is ignored with a console warning and the built
config opens. The remote map.json's own `configSources` is never read — a config
cannot authorise itself.

Keep the allowlist to locations whose writers you trust. A config supplies HTML the
app injects (featureinfo templates, metainfo, attribution), so whoever can publish
there can run script on the map's origin for anyone who opens such a link — the
server is unaffected, its visitors are not. See `src/config/config-source.ts`.

Caveats:

- `raw.githubusercontent.com` caches for ~5 minutes; a push shows up with that delay.
- Data URLs in the remote config must send CORS headers for the map's origin.
- Share links carry `variant` but not `config`, so a shared link reopens the built
  config.

## Adding a new project

1. Create `configs/<project>/`.
2. Add only the config files you want to override (copy a `public/` default or an existing
   project's file as a starting point). Omit the rest to inherit the defaults.
3. Build/deploy with `VITE_CONFIG_PROJECT=<project>`.

## Existing projects

- `woonzorglimburg/` — the public Limburg deployment (`map.woonzorglimburg.nl`),
  embedded by woonzorglimburg.nl. One
  [variant](#config-variants-multiple-datasets-in-one-build), `versie_1_0`, whose
  `layers.json` and `navigation.json` live under `versie_1_0/`. Old links naming
  `publiek` or `ontwikkel` fall back to it.
- `woonzorglimburg_ontwikkel/` — staging (`ontwikkel.woonzorglimburg.nl`), a
  separate project served behind basic auth. Flat (no variants); turns on
  `text_to_tool` / `speech_to_text`. Config changes are tried here first and
  copied into `woonzorglimburg/versie_1_0/` once approved. Its `filter.json`,
  `charts.json` and `dashboard_complementary.json` are copies of woonzorglimburg's
  — projects do not inherit from each other, so change both together.

  **Why a project, not a variant.** A variant cannot be access-controlled: every
  variant's `layers.json` is served from the same origin to anyone. From September
  to November 2026 staging was the public `ontwikkel` variant of `woonzorglimburg`;
  it moved back to its own project so its configuration needs the password.
  Its data on `dataontwikkel.woonzorglimburg.nl` is still public.
- `startanalyse2026/` — the national Startanalyse viewer. Shares `map.json`, `filter.json`
  and `charts.json`, and ships `layers.json` + `navigation.json` per model year under
  `2025/`, `2026/` and `2025_2026/` (see [Config variants](#config-variants-multiple-datasets-in-one-build)).
