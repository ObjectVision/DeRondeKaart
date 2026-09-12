# Layer metainfo

The documents behind the info button on a woonzorglimburg layer. `metadata.xlsx`
is the source of truth; everything else here is generated from it.

## Running it

One-time, because neither package ships with the repo:

```
pip install openpyxl pillow
```

Then, after every spreadsheet edit:

```
npm run metainfo
```

That writes three things:

| Output | Purpose |
|---|---|
| `resultaten/<id>.html` | standalone preview pages — open one in a browser to check a document without running the app |
| `fragmenten/<id>.html` | what the app fetches |
| `public/data/meta/` | the fragments and their images, copied where the app serves them |

The generated files under `public/data/meta/` are committed. The build does not
run this script: it would put Python on the critical path of a JS build, and
regenerating on every build makes a spreadsheet nobody touched produce diff
noise.

## Why there are two templates

`template/opmaak.html` is a whole HTML page that mimics the app's dialog, so a
document can be reviewed on its own. `template/fragment.html` is what the app
actually renders, and it deliberately carries none of that page furniture:

- **No `<!DOCTYPE>`, `<html>`, `<head>` or `<body>`.** `LeafMeta` injects the
  fragment with `innerHTML` into a div that already sits inside
  `LayerMetaDialog`, so a head is discarded — and the preview's stylesheet links
  are pinned to a build hash, so they 404 as soon as the app is rebuilt.
- **No backdrop, no `role="dialog"`, no close button.** The dialog already
  exists. A second one nested inside it paints a grey overlay across the whole
  app and offers two ways to close one window.
- **No tabs and no `<script>`.** `innerHTML` never executes script, so a tab bar
  would render but do nothing — and the sources panel, which the preview keeps
  `hidden` until a click, would be permanently invisible. The fragment stacks
  both panels as ordinary sections instead; the dialog scrolls.

Both templates take the same placeholders — `TITEL`, `THEMA_SUBTHEMA`,
`WAT_ZIET_U`, `KAARTLAAGTYPE_CONTENT`, `AANNAMES_EN_ONZEKERHEDEN`, `BRONNEN` —
and `{% if KEY %}…{% endif %}` drops a section whose value is empty.

## Which layers get a document

Only those with a **"Wat ziet u?"** text. A layer with nothing but a title and a
theme is skipped entirely, so its info button stays disabled: an empty dialog
reads as broken, while no button reads as "nothing written yet". Filling that
cell is all it takes to publish one.

The output filename is the layer id, so a new document is wired up by adding
`"meta": "/data/meta/<layer id>.html"` to that layer in
`configs/woonzorglimburg/layers.json`.

## Editing the spreadsheet

**Copy an existing row rather than typing a new one.** The reader looks up
sources under `Naam van de bron`, and a header spelled even slightly differently
resolves to an empty record — the source then renders with a blank bronhouder
and description, with no error anywhere.

Images in the `Logo` column and inside the kaartlaagtype descriptions are written
relative to the preview pages (`../afbeeldingen/…`). The generator rewrites them
for the fragments, so author them the preview's way and leave the rest to it.

## Images

`afbeeldingen/iconen/` are copied as they are. The kaartlaagtype diagrams are
~1300px PNGs of a few MB each, displayed a few hundred pixels wide, so they are
downscaled to 800px and converted to WebP — about 95% smaller, with nothing
visible lost at that size. The preview pages keep using the original PNGs.

## App-side pieces this depends on

Three things in the app exist for these documents, and all three fail quietly if
removed:

- `src/index.css` defines `--primary-color` (the section headings' colour) and
  the `.dro-meta` table striping. The striping is plain CSS rather than a
  Tailwind utility because Tailwind only scans source files — a class used only
  in runtime-fetched HTML is purged from the build.
- `src/index.css` also has an `@source` pointing at `public/data/meta`, so
  Tailwind sees the classes these fragments do use.
- `scripts/subset-icon-font.ts` keeps the `map`, `settings`, `help` and
  `database` glyphs. A glyph missing from that list renders as its own name in
  **built bundles only**, so a dev run gives no warning.
