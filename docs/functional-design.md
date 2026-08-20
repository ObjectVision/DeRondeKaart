# De Ronde kaart — Functional Design

**Audience:** everyone deciding *what* the application should do — product
owners, configuration authors, and developers checking a change against the
intent. This document describes the key functions of the intended web-mapping
application from the user's point of view.

**How it relates to the other documents.** This FD says *what* and *for whom*;
[system-design.md](system-design.md) says *how* — components, module structure
and state management. Styling internals live in
[system-design-styling.md](system-design-styling.md), the data preparation
chain in [preprocessing-pipeline.md](preprocessing-pipeline.md), and the
optional subsystems (collaborative annotation, the Power BI visual) in their
own companions. Section references below of the form *SD §n* point into
system-design.md.

---

## 1. Intended users

De Ronde kaart is a **read-only thematic map viewer**: it presents prepared
geospatial datasets transparently — clear class breaks, visible styling rules,
thorough meta-information — without requiring GIS skills or an account. Three
roles interact with it:

| Role | Uses the app to | Assumed skills |
|---|---|---|
| **Viewer** — policy analysts and advisors at provinces, municipalities, housing and care organisations (the deployments to date: *Woonzorganalyse Limburg*, *Startanalyse 2026*) | Explore thematic layers, filter to their own gemeente/wijk/buurt, compare scenarios side by side, read the numbers behind the map, share what they found | None beyond a browser. The app must be self-explanatory on desktop **and tablet** |
| **Configuration author** — the modeller or data steward of a deployment | Define every layer, class break, chart, filter level and navigation entry in five JSON files; prepare the data itself upstream in GeoDMS (see [preprocessing-pipeline.md](preprocessing-pipeline.md)) | GeoDMS, JSON; no app-code changes needed for a new deployment (SD §3.1) |
| **Embedder / integrator** | Use the app as a standalone page or embed it in an IFrame on another website — the full map or the circular embed view — driving layers, view and data through URL commands and host messages; a colleague opening a shared URL | The URL command and `postMessage` surface (SD §8) |

There is deliberately **no login and no server-side state**: everything a
viewer sees is determined by the deployment's configuration plus the state
they build up in their own session — which is why that state must be capturable
in a URL (§8).

## 2. State of the WebApp

Functionally, a session consists of the following state, layered by lifetime.
SD §3.3–§3.4 describe the stores and ownership; this table describes the
contract.

| State | Scope | Survives |
|---|---|---|
| **Active layers** — the ordered list per map side (A left, B right), with per-layer visibility, per-class visibility, dim state and timeseries step | per map side | Sharing via URL (layer list and layer-level hides; per-class hides and dim do not travel) |
| **Camera** — centre and zoom; the map is north-up by intent (rotation is not part of the product) | shared by both maps | URL |
| **Background reference layer** (*achtergrond referentielaag*) — the base cartography beneath all thematic layers: greyed built-up area, as vector cartography or *luchtfoto* aerial | shared | URL (only when non-default) |
| **Overlay reference layer** (*voorgrond referentielaag*) — topographic orientation drawn *above* the thematic layers: typically roads, railways, water, and labels | shared | follows the background choice |
| **Area filter** — the gemeente/wijk/buurt selection (§6) | shared, cross-cutting | not in URL (deliberate: a link shows the map, the recipient sets their own scope) |
| **Box selection** — a drawn rectangle scoping the statistics (§6) | shared | session only |
| **Feature pick / popup** — the clicked feature, its info popup, optional click marker and Street View target | one at a time, across both maps | session only |
| **Annotations** — drawn circles, polygons and pins, each carrying a snapshot of the session that created it | shared; optionally in a collaboration room | snapshot restore; room id travels in the URL ([system-design-collaboration.md](system-design-collaboration.md)) |
| **Panel chrome** — navigation/statistics/legend panels minimized or expanded, navigation tree expansion | per browser tab | `sessionStorage` |
| **Comparison slider position** | shared | session only |

The **initial state** is configuration: `map.json` supplies the starting
centre, zoom, study area outline, and ~15 UI feature flags (search, share,
annotations, Street View, navigation mode…). A deployment that
disables a feature flag simply does not render that function (SD §9).

## 3. Layer configuration, class breaks and visualisations

### 3.1 What kinds of layers exist

Every thematic layer is **classified**: it shows which class each feature or
cell falls in, never a raw value painted through a continuous colour ramp. The
class breaks are decided upstream in GeoDMS and written into the data as a
class attribute or band value; the app styles and labels those classes
([preprocessing-pipeline.md](preprocessing-pipeline.md)). That single decision
is what makes the legend exhaustive and the map readable — a viewer can always
name what a colour means.

Within that rule, five kinds of layer are supported.

| Kind | Typical content | How it is drawn |
|---|---|---|
| **Categorical polygon coverage** — the dominant case | An exhaustive tiling of the study area: buurten, wijken, grid cells, walking-distance zones, suitability classes. Geometry is multi-polygon; a feature may be several disjoint rings | One `Fill` class per rule, optionally with an outline. A class can be drawn as a **diagonal hatch** instead of a flat fill, which is how "not applicable" or "excluded" classes read as absent without disappearing from the legend |
| **Point layers** | Facilities and locations: GP practices, pharmacies, care homes, stops | A `Mark` (circle, sized by radius) for statistical points, or an `Icon` (a named symbol) where the category matters more than the count. Clicking snaps the marker to the feature, not the cursor pixel |
| **Line layers** | Roads, railways, routes, and administrative boundaries drawn as outlines only | A `Line` class per rule. A boundary layer is a polygon source with a transparent fill and a coloured stroke |
| **Continuous surfaces → classified raster** | Quantities that exist everywhere rather than per feature: heat demand, accessibility, density, elevation | A Cloud-Optimized GeoTIFF, classified **per pixel through the same rule syntax** as a vector layer — band values are exposed as `band0`, `band1`, … and the first matching rule paints the pixel; nodata is transparent. A raster that already carries its own colours (`embeddedColors`) is drawn as-is and its rules only populate the legend |
| **Composite layers** | One theme whose best source differs by zoom: generalized polygons when zoomed out, full detail when zoomed in | Several child sources under **one** navigation, legend and share entry; each child loads only while the map zoom is inside its band. The zoom-band mechanism in the tile pyramid is the data-side counterpart ([preprocessing-pipeline.md](preprocessing-pipeline.md)) |

Two properties cut across the kinds. A **timeseries** layer is one logical
layer over many yearly sources, played or scrubbed from the legend (§5). Any
tile-based layer may carry an attribute **sidecar** so its charts and
Kerncijfers cover the whole dataset rather than the tiles in view (§6).

The proportions in practice: *Startanalyse 2026* is 201 layers, all polygon
coverages, most with six classes and the largest with 21; *Woonzorganalyse
Limburg* mixes 51 polygon, 17 point and 3 line layers.

Two capabilities exist in the renderer but are not part of the intended product
today: **3-D extrusion** and **heatmaps**. Both can be reached by a raw style
override on a rule, and neither is used by any deployment — they are an escape
hatch, not a supported visualisation.

### 3.2 What a layer entry declares

Everything renderable is declared in `layers.json`, the deployment's layer
catalogue. A layer entry gives (SD §9, §5):

- **Identity and description** — `id`, display `name`, an optional `subname`
  carrying the unit the values are measured in ("GJ/jaar per WEQ"), a one-line
  `description`, and a `meta` reference (§4).
- **Data** — a `source` URL plus `format` (PMTiles, MVT, COG, FlatGeobuf,
  GeoJSON, or `composite`), the `sourceLayer` inside tiled sources, and
  `geometryType` (`point` / `line` / `polygon`), which decides how the class
  swatches are drawn and how a click resolves. Large attribute sets ride in a
  Parquet/Arrow `attributeSource` sidecar so charts aggregate the *whole*
  dataset, not just the tiles in view (SD §7). A FlatGeobuf layer loads only
  from a configured zoom inwards, reading just the current viewport — the
  format for detail that is only meaningful up close.
- **Placement** — a z-order band (`beforeid` anchor: background, map,
  foreground, overlay, study area; SD §5.4) so thematic fills never cover
  roads and labels.
- **Style: class breaks as GeoStyler rules.** A layer's classification is a
  list of named rules, each pairing a *filter* (which features belong to the
  class, e.g. `["==","class",1]` or range comparisons) with *symbolizers* (how
  the class looks: fill, line, point mark or icon — or per-pixel raster
  colouring for a COG, using the same rule syntax). Rules are evaluated first
  match wins, so specific classes go before catch-alls. **The class-break
  values themselves are computed upstream** — the GeoDMS stage classifies and
  writes a class attribute; the app only styles and labels the classes
  ([preprocessing-pipeline.md](preprocessing-pipeline.md),
  [system-design-styling.md](system-design-styling.md)).
- **Behaviour flags** — `featureinfo` popup template, `charts` and
  `statistics` references, `timeseries` (a year placeholder in the source that
  the viewer can play or scrub), and opt-outs: `excludeFromLegend`,
  `excludeFromPicking`, `excludeFromComparison`.

The functional guarantee behind this design: **style is authored once and
rendered, legended and exported from that single description** — the legend is
generated from the same rules that draw the map, so the two can never
disagree.

## 4. Relations between layers and meta-information

Transparency is a product goal (§1): every number on the map must be traceable
to what it means and where it came from. The configuration expresses that as
three levels of meta-information per layer:

| Level | Config | Where the viewer meets it |
|---|---|---|
| One-line **description** | `description` | Under the layer in the navigation tree |
| Full **metainfo page** — an HTML fragment: definition, source, method, year | `meta` | The ⓘ info button on the legend row and the navigation entry open it as a dialog. Layer links inside the fragment can add the related layer directly to the map |
| Per-feature **attributes** | `featureinfo.template` with `[[ field ]]` placeholders | The popup on click/tap (§6) |

Beyond meta-info, layers relate to each other through the configuration:
`navigation.json` groups layers into a category tree with icons and colours;
`charts.json` is a shared library of chart definitions that layers reference
by id; several layers may share one attribute sidecar (aggregated once); and a
timeseries layer is one logical layer over many yearly tile sets.

## 5. The legend — the layer control

The legend (panel *Kaartlagen*) is not a passive key: it is the viewer's layer
control, and every entry in it is generated from the layer's own styling rules
(SD §8, [legend.tsx](../src/components/ui/legend.tsx)). Per layer the viewer
can:

- **Show/hide** the whole layer, **dim** it (reduced opacity, for seeing
  through a fill), or **remove** it from the map.
- **Show/hide individual classes** — each class-break row has its own toggle,
  so "only the two highest classes" is one click per class. (Raster/COG layers
  classify per pixel and toggle only as a whole.)
- **Reorder** layers by dragging, within the z-band the configuration assigned.
- **Move a layer to the other map** in comparison mode (§9).
- **Play or scrub a timeseries** — a play/pause control and year slider appear
  under a timeseries layer's name.
- **Open the metainfo dialog** from the ⓘ button (§4).
- **Switch the basemap** (vector cartography ↔ aerial photo) from the
  *Referentielagen* dialog.

## 6. Selection and filtering

Three complementary mechanisms, with deliberately different scopes (SD §6):

**Feature picking.** Click (mouse) or tap (touch) on a feature opens its
info popup, rendered from the layer's `featureinfo` template; an optional
click marker and a Street View panel can accompany it. Picking respects the
area filter — a filtered-out feature is not drawn and therefore not pickable.
One pick is active at a time across both maps.

**Area filter.** Cascading administrative dropdowns (configured in
`filter.json`; in the current deployments *Gemeente → Wijk → Buurt*). The
semantics are fixed: **AND across levels, OR within a level, inapplicable
levels skipped, empty selection passes everything**; layers without the exact
code column fall back on the nesting of CBS codes. Selecting an area does
three things at once: the map renders only matching features, the charts and
Kerncijfers aggregate only matching rows, and the view **flies to the
selection**, which also becomes the study-area outline. This is the "zoom to
my region" function (§7).

**Box selection.** A toolbar-armed rectangle drag that scopes **statistics
only** — the map keeps rendering everything, but charts and Kerncijfers
recompute over the features inside the box. Drawing a new box replaces the
old; toggling the tool off or pressing Escape clears it. Area filter and box
selection compose: a row must pass both.

The statistics side of filtering is a first-class function: each layer can
declare up to four charts (donut, bar, line; sum/mean/count) plus a
*Kerncijfers* grid (sum, count, mean, variance), always aggregated over the
full dataset from the attribute sidecar — never from the visible tiles, so
numbers do not change when the user pans (SD §7).

## 7. Zooming to a specific region

Four routes, all resolving through one bbox-to-camera heuristic (SD §3.4):

1. **Area filter** — selecting a gemeente/wijk/buurt flies to it (§6). This is
   the primary "my region" flow.
2. **Location search** — a search box (Nominatim geocoding) flies to a typed
   place name or address. Enabled per deployment via `map.json`.
3. **URL** — a link can carry `zoom` and `center` (§8).
4. **Host commands** — an embedding host (Power BI) sends a raw bbox and the
   app resolves the camera.

The configured initial view and study area (`map.json`) define where a fresh
session starts.

## 8. Map state in a URL

Any session worth showing a colleague must be reproducible from a link. The
share dialog builds a URL whose hash encodes, in order: the camera
(`zoom`, `center`), an `add` command for every layer on map A and map B plus a
`hide` command for each hidden one, the basemap when it differs from the
default, and — when a collaboration session is live — the annotation room id.
Opening the link replays those commands through the same pipeline that drives
the app normally, so the recipient gets the same layers on the same maps at
the same place ([share-url.ts](../src/lib/share-url.ts),
[use-url-commands.ts](../src/hooks/use-url-commands.ts)).

Two functional limits are accepted by design: **per-class hides and dim state
do not travel** (there is no per-rule URL command), and **in-memory datasets
pushed by an embedding host are not addressable** — the recipient's app could
not resolve them, so they are dropped from the link.

The same URL surface accepts imperative commands (`add`/`remove`/`hide`/
`refresh` per map side), which is what makes the app drivable from documents,
e-mails and dashboards without any integration code. Sharing also offers a
**circular PNG export** (map with legend and callouts) and a matching
`?embed=circular` view for embedding.

## 9. Comparison mode — the "vergelijkingsschuif"

Comparison is a core function, not an add-on: the product exists to put two
states of the world side by side — scenario against scenario, year against
year, indicator against indicator.

- The app runs **two synchronized maps**: one camera, one basemap, two layer
  stacks (A and B). The right map materialises when a comparable layer is
  placed on side B; layers flagged `excludeFromComparison` (context layers,
  study area) stay on both sides.
- Layers reach a side through the **navigation tree's A/B checkboxes** or by
  **moving a layer** from the legend (§5).
- The **vergelijkingsschuif** (comparison slider) is a vertical handle across
  the viewport: everything left of it shows map A, everything right shows
  map B. Dragging it — mouse or finger — sweeps the split across the screen,
  the direct visual answer to "what changes between these two?". Panning and
  zooming remain live on both sides while sliding.
- Picking, popups, filters, charts and sharing all understand the two-map
  state: a click on one side clears the other side's pick; the share URL
  encodes both stacks (§8).

## 10. Mouse and tablet gestures

The app must be fully operable with a mouse **and** on a tablet with touch.
The map is intended north-up: rotation is not part of the interaction model
(mouse rotation is disabled).

| Intent | Mouse / keyboard | Touch (tablet) |
|---|---|---|
| Pan | drag | one-finger drag |
| Zoom | scroll wheel; double-click; `+`/`−` keys; shift-drag a rectangle to zoom to it | pinch; double-tap |
| Pick a feature (§6) | click | tap |
| Box selection (§6) | with the tool armed: press-drag-release (a movement under ~3 px still counts as a plain click); `Escape` cancels or clears | with the tool armed: touch-drag |
| Comparison slider (§9) | drag the handle | drag the handle |
| Popups and dialogs | `Escape` closes, backdrop click closes | tap outside |

Hover-only affordances (cursor changes, hover highlights) are enhancements,
never the sole path to a function — every action reachable by hover is also
reachable by click/tap, which is what keeps the tablet experience complete.

## 11. Related documents

| Topic | Document |
|---|---|
| Components, state management, module structure | [system-design.md](system-design.md) |
| Style model and the three render targets | [system-design-styling.md](system-design-styling.md) |
| Data preparation: GeoDMS → converters → tiles, and why generalization happens upstream | [preprocessing-pipeline.md](preprocessing-pipeline.md) |
| Collaborative annotation | [system-design-collaboration.md](system-design-collaboration.md) |
| Power BI custom visual | `DeRondeKaart_powerbi` repository |
| Dependency version constraints | [system-design-version-constraints.md](system-design-version-constraints.md) |
