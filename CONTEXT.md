# CONTEXT.md

Domain glossary for De Ronde kaart. One place to look up what a word means in
this codebase, and which spelling to use when naming something new.

This is deliberately *not* an architecture document — `docs/system-design.md`
covers how the parts fit together and `docs/functional-design.md` covers what
the app does for its users. Here each term gets a sentence or two and a pointer.

**Code, comments and docs are in English; user-facing strings are in Dutch.** So
several concepts have two names: the one you write in code and the one the user
reads. Both are listed, because using the Dutch word in code (or translating the
Dutch term afresh in each component) is how they drift apart.

## The map

**Side** — which of the two maps something refers to: `"left"` or `"right"`.
The type is `MapSideId` and the pair type is `MapSidePair<T>`; resolve one with
`forSide(pair, side)`. See `src/lib/map-side.ts`.

Two spellings persist deliberately and must not be "tidied":

- `"a"` / `"b"` is the **wire** format, in share-link URLs (`map=a`) and host
  `map-command` messages. Convert with `sideFromWire` / `sideToWire`; nothing
  else should spell it. Links already shared depend on it.
- `mapA` / `mapB` are the keys inside a stored **annotation snapshot**, which
  lives in Yjs documents that predate the left/right naming.

**Comparison mode** (Dutch: *vergelijkingsschuif*, the comparison slider) — both
maps shown at once with a draggable divider between them. It turns on by itself
once the right map holds a layer that counts as comparison content; a layer with
`excludeFromComparison` does not count. See `showMapRight` in `src/App.tsx` and
`docs/functional-design.md` §9.

> **Verschilkaart** is what the UI calls this to users — the name of the guide
> tab that explains it (`src/components/ui/map-attribution.tsx`). It is the same
> comparison mode, not a separate feature or a distinct kind of layer. Prefer
> *comparison mode* in code and *Verschilkaart* in Dutch user-facing text.

**Basemap** — the background style, a whole MapLibre style rather than a layer.
Switching one wipes every source and layer on the map, which is why several
modules expose a `resync()` that re-adds their own.

## Layers

**Layer config** — one entry in `layers.json`: an id, a format, a source, and how
to style it. The catalogue, not the map. Type `LayerConfig` in
`src/layers/types.ts`.

**Layer entry** — a layer config that is *on* a map, held in one side's stack.
`LayerEntry` in `src/hooks/use-map-layers.ts`. The stack is bottom-to-top draw
order and is the single source of truth for z-order.

A config reaches a map only through the navigation tree, a share link, the study
area, the pick layer, or the dashboard's selection layers. Being in `layers.json`
puts nothing on screen.

**Rule** — one class of a layer's legend: a GeoStyler filter plus the symbolizer
to paint what matches. `geostyler.rules` in a layer config. Each rule becomes its
own native MapLibre layer, which is what lets the legend toggle classes
independently.

**Composite** — a layer whose config nests **child** configs, swapped by zoom so
one legend entry can be backed by several archives. Children are never layer
entries: they exist only as native sources on the map. Their synthesized ids end
in `__c<index>`.

**Format** — how a layer's data arrives: `mvt`, `pmtiles`, `cog`, `flatgeobuf`,
`geojson` (in-memory, pushed by an embedding host), or `composite`.
`docs/system-design.md` §5.

**Study area** (Dutch: *studiegebied*) — the boundary layer naming the region a
project covers, from `map.json`'s `studyarea`. Loaded outside `useMapLayers` on
its own channel, so it stays out of the legend, picking and comparison.

**Pick layer** — an invisible layer, named by `map.json`'s `pickLayer`, whose
only job is to answer clicks. Absent from the legend and navigation, added by
`addPickLayer` to *both* maps. See `src/lib/pick-layer.ts`.

## Filtering and selection

**Gebiedsfilter** (area filter) — the cascading region filter: pick a
municipality, then a district, then a neighbourhood, each narrowing the next.
Configured in `filter.json`, where the levels are project-defined rather than
fixed. Named `areaFilter` in code, but *gebiedsfilter* is the word used in
comments and in conversation, so both appear. `src/layers/area-filter.ts`.

**Combination** (Dutch: *Combinaties*) — a layer the user builds in-session by
scoring how many chosen classes each grid cell passes. Session-scoped: never in
`layers.json`, gone on reload. `src/layers/filter-layers.ts`.

**Slot** — one of the (at most four) areas held side by side in the dashboard's
comparison panel. `src/layers/compare-slots.ts`.

## Configuration

**Project** — one deployment's content, a directory under `configs/<slug>/`
selected at build time with `VITE_CONFIG_PROJECT`. It overlays `public/`, and
replaces files whole rather than merging.

**Variant** — two datasets shipped in one build and switched at runtime without a
reload, typically model years (2025 / 2026). Only `layers.json` and
`navigation.json` differ per variant; the rest stay shared. `src/config/variant.ts`
and `configs/README.md`.

The hazard to know: **layer ids are reused between variants**. Anything keyed by
id holds a value that is *wrong*, not merely stale, once the variant changes, and
nothing errors — the map keeps working and shows the other year's answer. A cache
in that position registers itself with `registerVariantScopedCache`
(`src/config/variant-scope.ts`) so the switch clears it. Caches keyed by URL do
not, because a URL means the same document under either variant.

## Embedding and collaboration

**Host** — a page embedding the map in an iframe and driving it over
postMessage: layer commands, view changes, filter selections, variant switches,
and pushed `geojson` datasets. `src/hooks/use-url-commands.ts` and
`use-embed-data.ts`.

**Annotation** — a user-drawn circle, polygon or pin, with a stored **snapshot**
of the session (both maps' layers, hidden ids, gebiedsfilter selections, camera)
so opening one restores what its author was looking at.

**Room** — a collaborative annotation session, identified by a UUID carried in a
share link's `annot` parameter. Peers in a room see each other's annotations and
cursors live. `docs/system-design-collaboration.md`.

## Dashboard

**Standalone** dashboard — a card of charts and figures rendered over the map.
**Complementary** dashboard — the mode where clicking areas puts them into
comparison slots and "meer informatie" opens a panel over them. `map.json`'s
`dashboard` selects `"off"`, `"standalone"`, `"complementary"` or `"both"`.

**Semantic model** — the dashboard's tables, relationships, measures and
dimensions, from `dashboard_semantic_model.json`. Queried through DuckDB-WASM.

## Where the rest lives

- `docs/functional-design.md` — what the app does, from the user's side
- `docs/system-design.md` — architecture, module structure, the config system
- `docs/code-standards.md` — the coding conventions
- `configs/README.md` — the config overlay and variants in full
- `AGENTS.md` — the house rules every agent reads
