# Locatie informatie

The template and data behind the "Locatie informatie" window: what a click on the
map opens in woonzorglimburg (see `featureinfo.locationinfo` in
`configs/README.md`).

## Three files that belong together

| File | Built from | Holds |
|---|---|---|
| `pmtiles/pc6_locatieinfo_2026.pmtiles` | GeoDMS `.../locatieinfo_pc6_geojson/export_klik` | PC6 polygons with only `pc6` and `row` |
| `parquet/pc6_locatieinfo_2026.parquet` | GeoDMS `.../locatieinfo_pc6_geojson/export` | One row per PC6, in the same order: every field the template uses |
| `meta/locatieinfo/locatie-informatie.html` | `template/locatie-informatie.html` here | The window's layout |

The click reads `row` from the tile and fetches exactly that row of the parquet over
HTTP range requests. **Rebuild and upload the PMTiles and parquet together**: with
`keyField: "pc6"` in the config, a pair out of step shows an error rather than another
postcode's data. Give both the same `?v=` stamp in `layers.json`.

The GeoDMS item is `/Brondata/CBS_100m_vector_grid/data/Y2026/WonenZorgNoordMiddenLimburg/locatieinfo_pc6_geojson`
in `WoonZorgwijzer_clientside_rendering/cfg/stam/brondata.dms`.

## Building

```bash
# GeoDMS (Git Bash: MSYS_NO_PATHCONV=1, or item paths are mangled into Windows paths)
GeoDmsRun.exe cfg/stam.dms .../locatieinfo_pc6_geojson/export_klik .../locatieinfo_pc6_geojson/export

# Parquet: a click downloads the footer once, then one row group per new area.
# The footer grows with row groups x columns, a group with its row count; 1024
# rows gave ~390 KB footer and ~250 KB per group for 31k rows x 134 columns.
python data/convert-geojson-to-parquet.py <...>/pc6_locatieinfo_2026.geojson data/parquet/pc6_locatieinfo_2026.parquet --batch-size 1024 --no-statistics

# PMTiles (OSGeo4W shell)
python data/convert-geojson-to-pmtiles.py --layer pc6_locatieinfo_2026=<...>/pc6_klik_2026.geojson@8-14 -o data/pmtiles/pc6_locatieinfo_2026.pmtiles
```

## The template

A body fragment, not a full document:

```html
<div data-locationinfo="general">…</div>          <!-- block beside Street View -->
<section data-tab="gebouw" data-label="Gebouw" data-icon="home_work">…</section>
<p data-locationinfo="footer">…</p>
```

Tabs appear in document order. `kaartlagen` is reserved: the window adds that tab
itself for other layers the click hit.

**Placeholders** — `[[ field ]]` or `[[ field | format ]]`, values HTML-escaped,
missing values shown as `–`. Formats: `text` (default), `int`, `dec1`, `pct`
(value already in percent), `m` ("580 meter"), `postcode` (`6211AB` → `6211 AB`).

**Widgets** — scripts in the template do not run, so these replace them:

- `<div data-pie data-pie-label="…">` with `<i data-slice="field" data-color="rgb(…)" data-name="…">`
  children: a pie (conic gradient) over the fields, normalised to their sum.
- `<td data-distance="field" data-breaks="500 1000">`: "580 meter", green below the
  first break, orange below the second, red above.
- `<div data-sparkline="aandeel_0_17_{year}" data-years="2026-2040" data-color="…" data-label="…">`:
  a trend line with its first and last value.

**Styling** is Tailwind utilities. The template is fetched from the data host, so
Tailwind sees it only through `@source` in `src/index.css`: a class that appears
nowhere else takes effect after the **app** is rebuilt, not merely after the
template is uploaded.

## Publishing

Upload to `/var/www/woonzorglimburg_data/{parquet,pmtiles,meta/locatieinfo}/` on the
data host, back up what is replaced, and bump the `?v=` stamps in both variants'
`layers.json`.
