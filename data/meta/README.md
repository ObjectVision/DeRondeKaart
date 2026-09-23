# Layer metainfo

The documents behind the info button on a layer. `<project>/metadata.xlsx` is the
source of truth; everything else here is generated from it.

## Running it

One-time, because neither package ships with the repo:

```
pip install openpyxl pillow
```

Then, after every spreadsheet edit:

```
npm run metainfo
```

Add a project name to do just one: `python data/meta/genereer_html.py woonzorglimburg`.

That fills `<project>/resultaten/`, which is a **mirror of what the fileserver
holds** — the fragments, the hand-written documents and the images, laid out
exactly as they are served. Publishing is then a plain recursive copy:

```
scp -r data/meta/woonzorglimburg/resultaten/* cicada@37.97.169.242:/var/www/woonzorglimburg_data/meta/
```

`/var/www/woonzorglimburg_data` is root-owned, so the directory itself was
created with `sudo`; the contents belong to `cicada` and need no privileges to
replace. `scp` overwrites and never deletes, so a document dropped from the
spreadsheet stays on the server until it is removed by hand.

**The published documents are not in this repo.** They are content, regenerated
whenever the spreadsheet changes, and `resultaten/` is gitignored. Everything
needed to rebuild them — the spreadsheet, the templates, the images, the
hand-written documents and this script — *is* versioned. The build does not run
this script either: it would put Python on the critical path of a JS build.

## Projects

Each project is a folder here holding a `metadata.xlsx`. `woonzorglimburg` is the
only one so far. Folders named `metainformatie_concept_*` are dated working
copies of somebody's spreadsheet and are skipped — they hold a `metadata.xlsx`
too, and would otherwise generate as if each were a project of its own.

The server directory is flat rather than split per project, and two projects
naming a layer the same would collide there — give the second project its own
subdirectory before adding it.

## Three fragments per layer, one per tab

The metainfo dialog shows up to three tabs, and each is its own file:

```
<layer id>_toelichting.html                 Wat ziet u? + Berekenwijze
<layer id>_bronnen.html                     Databronnen
<layer id>_aannames_en_onzekerheden.html    Aannames en onzekerheden
```

**A route with nothing to say writes no file**, and that layer's `meta` in
layers.json omits the key — which is what makes the tab disappear. An empty tab
leading to an apology says nothing a missing tab does not.

Wire a layer up by pointing `meta` at the files that exist. The URLs are
absolute, because the app is on a different origin than the documents:

```json
"meta": {
  "toelichting": "https://data.woonzorglimburg.nl/meta/huisarts_toelichting.html",
  "bronnen": "https://data.woonzorglimburg.nl/meta/huisarts_bronnen.html",
  "aannames_en_onzekerheden": "https://data.woonzorglimburg.nl/meta/huisarts_aannames_en_onzekerheden.html"
}
```

Serving them cross-origin needs no server configuration: `data.woonzorglimburg.nl`
already sends `Access-Control-Allow-Origin: *`, and both app vhosts already list
it in their CSP `connect-src`.

`meta` also still accepts a plain string or an array of them; either renders as a
single **Toelichting** tab. That is what startanalyse2026's externally hosted
documents use, and what `woningbouwkaart.html` uses here.

Documents written by hand rather than generated live in `handmatig/` and are
copied into the mirror verbatim. Keeping them there rather than only on the
server is what stops them being the one thing nobody has a copy of.

## Why the fragments carry no page furniture

They have no `<!DOCTYPE>`, `<html>`, `<head>` or `<body>`, no backdrop, no
`role="dialog"`, no close button, **no tab strip and no `<script>`**. `LeafMeta`
injects a fragment with `innerHTML` into a div that already sits inside
`LayerMetaDialog`, so a head is discarded and a second dialog nested in the first
would paint a grey overlay across the whole app.

The tab strip in particular is the app's, not the fragment's: `innerHTML` never
executes script, so a tab bar shipped inside a fragment would render and do
nothing, and a panel it left `hidden` would be permanently invisible. That is the
reason the document arrives pre-split into three files rather than as one file
with three tabs in it.

`template/_kop.html` is the title-and-thema card, inlined at the top of all three
route templates so every tab still says which layer it describes. Templates take
`{{ KEY }}` placeholders — `TITEL`, `THEMA_SUBTHEMA`, `WAT_ZIET_U`,
`KAARTLAAGTYPE_CONTENT`, `AANNAMES_EN_ONZEKERHEDEN`, `BRONNEN` — and
`{% if KEY %}…{% endif %}` drops a section whose value is empty.

## Which layers get a document

Only those with a **"Wat ziet u?"** text. A layer with nothing but a title and a
theme is skipped entirely, so its info button stays disabled: an empty dialog
reads as broken, while no button reads as "nothing written yet". Filling that
cell is all it takes to publish one.

## Editing the spreadsheet

**Copy an existing row rather than typing a new one.** The reader looks up
sources under `Naam van de bron`, and a header spelled even slightly differently
resolves to an empty record — the source then renders with a blank bronhouder
and description, with no error anywhere.

Images in the `Logo` column and inside the kaartlaagtype descriptions still carry
the `../afbeeldingen/…` prefix from when these documents were standalone pages.
The generator strips and re-roots them, so author them that way and leave the
rest to it.

## Images

`afbeeldingen/iconen/` are copied as they are. The kaartlaagtype diagrams are
~1300px PNGs of a few MB each, displayed a few hundred pixels wide, so they are
downscaled to 800px and converted to WebP — about 95% smaller, with nothing
visible lost at that size.

Image URLs inside a fragment must be **absolute**
(`https://data.woonzorglimburg.nl/meta/afbeeldingen/…`). The fragment is injected
into an app on another origin, so a root-relative path would resolve against the
app and a document-relative one against whatever route it happens to be showing.

## App-side pieces this depends on

Four things in the app exist for these documents, and all four fail quietly if
removed:

- `src/index.css` defines `--primary-color` (the section headings' colour) and
  the `.dro-meta` table striping. The striping is plain CSS rather than a
  Tailwind utility because Tailwind only scans source files — a class used only
  in runtime-fetched HTML is purged from the build.
- `src/index.css` has `@source` directives pointing at `template/` and
  `handmatig/`, plus two `@source inline(...)` lists. Tailwind cannot see the
  published fragments at all — they are on another origin — so a utility only
  they use is purged and the fragment renders unstyled, with nothing failing.
  It also does not extract from `.py`, which is why the classes this script
  injects, and the ones written into the spreadsheet's own diagram markup, are
  listed inline. **Add a class in a template, in this script, or in the
  spreadsheet's HTML, and check `src/index.css`.**
- `scripts/subset-icon-font.ts` keeps the `map`, `settings`, `help` and
  `database` glyphs. A glyph missing from that list renders as its own name in
  **built bundles only**, so a dev run gives no warning.
- `src/layers/config.ts` validates the `meta` object form. A key it does not know
  is dropped with a console warning, not an error.
