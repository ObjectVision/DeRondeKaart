# Preprocessing pipeline — how polygon geometry survives tiling

This document records a source-level analysis of what actually happens to
polygon coordinates on their way into a `.pmtiles` archive: where they are
rounded onto tile-local raster points, what repairs that rounding triggers, and
why shared boundaries between adjacent polygons survive it — and where they
don't. It is the detailed companion to
[system-design.md §10](system-design.md#10-data-pipeline), which keeps the
operational overview.

The analysis was done in August 2026 against **GDAL 3.12.4**. All code
references point to
[`ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp`](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp)
at the `v3.12.4` tag (reader and writer live merged in that one file; older GDAL
versions keep the writer in `ogrmvtwriterdataset.cpp`). The PMTiles driver does
not process geometry itself — it wraps GDAL's MVT writer, so everything below
applies to both `MVT` and `PMTiles` outputs.

## 1. The two-stage pipeline

Geometry reaches the browser in two stages with a sharp division of labour:

1. **Generalization happens upstream, in GeoDMS (or mapshaper).** Source data is
   translated and — where needed — simplified into intermediate `.geojson`
   files. This is the *only* stage that is topology-aware across features:
   adjacent polygons keep their shared borders consistent because the tool
   simplifies the shared arc once, not each polygon independently.
2. **Tiling happens in GDAL's MVT writer** via
   [`convert-geojson-to-pmtiles.py`](../data/convert-geojson-to-pmtiles.py).
   This stage is *not* topology-aware across features — see §4 — but it is
   deterministic in a way that preserves adjacency anyway, provided the input
   respects one rule: **adjacent polygons must describe their shared border
   with identical vertex sequences.**

The converter script itself does no geometry work at all. It stages all inputs
into one in-memory OGR dataset (lowercasing field names, optionally unquoting
string values), builds the `CONF` zoom-band mapping, and hands everything to a
single `gdal.VectorTranslate(format="PMTiles")` call. Every coordinate
transformation below is the driver's.

## 2. What the driver does per (feature, tile)

The entry point is `OGRMVTWriterDataset::PreGenerateForTileReal`
([L4055](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L4055)).
For every feature and every tile it touches, at every zoom level:

### 2.1 Clip in world coordinates, before any rounding

The tile rectangle is expanded by a buffer — default `BUFFER = 80` grid units,
computed as 5 pixels of a 256-px tile
(`m_nBuffer = 5 * knDEFAULT_EXTENT / 256`,
[L3386](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L3386);
`knDEFAULT_EXTENT = 4096` in
[`mvt_tile.h` L56](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/mvt_tile.h#L56))
— and the feature is clipped against it with a GEOS `Intersection()` in
double-precision Web Mercator
([L4083–L4099](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L4083)).
Features whose envelope fits inside the buffered rectangle skip the clip.

The buffer is why features crossing a tile edge render seamlessly: both
neighbouring tiles carry the geometry a little past their edge, and the
renderer's clip window hides the cut.

### 2.2 Optional per-feature simplification

If `SIMPLIFICATION` is set, the clipped geometry goes through GEOS
`SimplifyPreserveTopology(dfTol * dfSimplification)` with
`dfTol = dfTileDim / EXTENT` — the tolerance unit is exactly one integer grid
cell
([L4126–L4142](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L4126)).
Off by default. **"Preserve topology" here is per-feature**: it prevents a ring
from self-intersecting or collapsing, but two adjacent polygons are simplified
independently, so their shared border can diverge. See §4.

### 2.3 The snap: `ConvertToTileCoords`

The entire "rounding to tile-local raster points" is two lines
([L3704–L3721](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L3704)):

```cpp
nX = static_cast<int>(std::round((dfX - dfTopX) * m_nExtent / dfTileDim));
nY = static_cast<int>(std::round((dfTopY - dfY) * m_nExtent / dfTileDim));
```

A stateless pure function of the world coordinate and the tile frame — no
neighbour-aware snapping, no snap-rounding arrangement. At `EXTENT = 4096` the
grid resolution follows the zoom: a z13 tile spans ≈ 4.9 km, giving ≈ 1.2 m per
grid unit; z14 halves that.

Note the `dfTileDim == 0` branch just above the formula: it means "the
coordinates are already tile integers, just cast". The repair path (§2.5) uses
it to stay on-grid.

### 2.4 Degeneracy collapse and integer-space winding

`EncodeLineString`
([L3736](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L3736))
walks the snapped ring and:

- merges consecutive points that landed in the same grid cell (the
  `nDiffX != 0 || nDiffY != 0` test);
- drops a closing point identical to the first;
- keeps a ring only if at least three distinct points survive.

The winding check runs **on the already-quantized ring**, not on the input —
the comment at
[L3753](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L3753)
explains why: *"very flat rings in non rounded coordinates can change
orientation after going to integer coordinates!"* Outer rings are forced
clockwise and inner rings counter-clockwise (screen-space Y-down convention,
per the MVT spec); a ring that arrives in the wrong order is reversed, but an
inner ring whose orientation *flips under rounding* is discarded as degenerate.
This is why the converter script deliberately performs no ring-winding
normalization on input: it would not survive.

### 2.5 Validity repair — in integer space

While encoding, the writer mirrors the emitted integer coordinates into a
shadow OGR polygon. If GEOS `IsValid()` fails on that quantized polygon —
a self-intersection created by the rounding — the already-encoded commands are
rolled back, `MakeValid()` runs **on the integer-coordinate geometry**, and the
repaired result is re-encoded through the `dfTileDim == 0` branch of the snap
([L4301–L4319](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L4301);
multipolygon variant L4321–L4360).

Running the repair in integer tile space is what keeps repaired output snapped
to the same grid the neighbours snapped to: `MakeValid`'s node-and-rebuild
points derive from grid vertices, and re-encoding rounds any intersection
points back onto the grid. (An older `Buffer(0)`-based repair still sits in the
file under `#ifdef notdef`,
[L3879](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L3879).)

### 2.6 A second gauntlet at tile assembly

A finished tile that exceeds `MAX_SIZE` (default 500 000 bytes, after
compression) is re-encoded at progressively halved extent — 4096 → 2048 → … →
256
([L5147–L5152](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L5147))
— which is a **second rounding pass**. `RecodeTileLowerResolution` applies the
same discipline to the reduced coordinates
([L4745–L4890](https://github.com/OSGeo/gdal/blob/v3.12.4/ogr/ogrsf_frmts/mvt/ogrmvtdataset.cpp#L4745)):
rings with fewer than three distinct points are removed; an outer ring that
inverts under reduction is dropped **together with all its inner rings**; an
inner ring that inverts to an outer is dropped; every surviving outer+inner
pair is re-checked with `IsValid()`. If the tile is still too big, features are
dropped smallest-first — quietly. This thinning is the failure mode to watch:
raise `MAX_SIZE` (as the Startanalyse build does) rather than let low-zoom
tiles silently lose their smallest polygons.

## 3. Why adjacency survives: determinism, not enforcement

Nothing in the writer knows that two features are neighbours. Features are
processed independently — concurrently, even (a thread pool feeds
`PreGenerateForTileReal`). The adjacency preservation is **emergent from
determinism**:

- The snap (§2.3) is a pure function of world coordinate and tile frame. Two
  polygons that share vertices in the input produce *identical* integer points
  in the same tile. A shared border stays shared; rounding cannot open a gap or
  a sliver along an edge whose vertices coincide in the input.
- The repairs (§2.4–2.6) are designed to stay inside that guarantee: winding
  decisions, degenerate-ring drops and `MakeValid` all operate on the quantized
  integer coordinates, never on re-projected doubles.
- Across tile boundaries the same argument applies: both features are clipped
  against the same buffered rectangle and snapped in the same tile frame, and
  the buffer pushes clip-edge artifacts outside the rendered window.

## 4. Where adjacency does *not* survive

The determinism argument has exactly the preconditions it sounds like, and each
one is a practical rule for this repo:

| Failure mode | Cause | Rule |
|---|---|---|
| Sub-pixel slivers along a shared border | The neighbours describe the border with **different vertex sequences** (one has an extra vertex on the segment). The extra vertex rounds off the neighbour's straight edge. | Shared borders must be vertex-identical in the intermediate GeoJSON. GeoDMS produces this naturally when both polygons derive from the same arcs. |
| Shared borders diverge at lower zooms | Driver `SIMPLIFICATION` is per-feature (§2.2): each neighbour simplifies its copy of the border independently. | Never use `--simplification` on adjacent polygon coverages (buurten, panden). Generalize upstream with a topology-aware tool and feed the result in as a zoom band (`--layer name=coarse.geojson@6-11` + `name=detail.geojson@12-14`). |
| Local mismatch at a repaired spot | `MakeValid` (§2.5) rebuilds **one** feature without consulting its neighbour. | Rare, sub-pixel by construction (the repair stays on-grid), and triggered only when rounding makes a ring self-intersect — near-degenerate input geometry. Clean input avoids it. |
| Smallest polygons vanish from a tile | `MAX_SIZE` thinning (§2.6). | Raise `--max-size` for low-zoom tiles that hold the whole dataset. |

The summary judgment: MVT tiling preserves *rendering-level* adjacency, not
OGC-valid topology. Winding is normalized per tile, features straddling tile
borders are duplicated, degenerate rings vanish, and validity is restored by
repair rather than preserved by construction. That is the correct contract for
a display format — but it means every decision that needs true topology
(generalization, border consistency, dissolves) belongs in the GeoDMS stage,
before the tiler ever sees the data.
