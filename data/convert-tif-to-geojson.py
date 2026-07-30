#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "numpy>=1.24",
#   "pyogrio>=0.7",
#   "rasterio>=1.3",
#   "shapely>=2.0",
# ]
# ///
"""Convert a classified (integer) GeoTIFF to GeoJSON polygons — raster to vector.

This is the counterpart to ``convert-tif-to-cog.py``. That script keeps a raster
a raster; this one turns it into features. Vectorising is what you want when the
raster holds a **small number of discrete classes** (land use, a score band, a
suitability class) rather than a continuous surface, because features can then be
styled per-attribute, clicked, area-filtered, and — most importantly — fed into
the ``convert-geojson-to-*.py`` converters in this folder to reach PMTiles,
FlatGeobuf or (Geo)Parquet. A COG can do none of that. For continuous data
(elevation, density, imagery) stay with ``convert-tif-to-cog.py``.

Each **connected region** of equal-valued cells becomes one Polygon feature with
a ``class`` property carrying the cell value. Nodata cells are dropped entirely,
so the output covers only the classified area.

Topology
--------
The whole difficulty here is the simplification step. Polygonising a raster
produces blocky, stair-stepped outlines with a vertex at every cell corner —
20 MB of GeoJSON for a 5 m raster of Limburg — so it has to be simplified. But
neighbouring regions **share** their border: simplify each polygon on its own
(as ``shapely.simplify()`` does) and that shared border is simplified twice,
independently, once from each side. The two results differ, and you get slivers
and overlaps along every internal boundary.

So simplification is delegated to **mapshaper**, which builds a topology first:
each shared border becomes a single arc, the arc is simplified **once**, and both
neighbours are rebuilt from it. Borders therefore stay exactly coincident. On the
reference raster this holds precisely — zero overlap and zero gap area between
classes at 20%, 10% and 5% retention, with area drift of 0.02%, 0.08% and 0.4%.

``keep-shapes`` is passed so small regions are never simplified out of existence,
and ``-clean`` repairs any residual self-intersection.

mapshaper is a Node tool, not a Python one. It is used through ``npx mapshaper``
(no install needed if the repo's node_modules are present) or a global
``mapshaper`` on PATH. If neither is found the script says so and exits; install
with:

    npm install -g mapshaper

Output is reprojected to WGS84 (EPSG:4326) by default, as RFC 7946 requires and
as the ``convert-geojson-to-*.py`` scripts expect. ``--no-reproject`` keeps the
source CRS.

Usage:
    # Default: tif/classes.tif -> tif/classes.geojson, simplified to 10%
    python3 convert-tif-to-geojson.py tif/classes.tif

    # Explicit input/output:
    python3 convert-tif-to-geojson.py path/to/in.tif path/to/out.geojson

    # Keep more detail (30% of vertices), or none at all (100% = no simplify):
    python3 convert-tif-to-geojson.py tif/classes.tif --simplify 30
    python3 convert-tif-to-geojson.py tif/classes.tif --simplify 100

    # The raster marks nodata with 0 instead of the assumed 255:
    python3 convert-tif-to-geojson.py tif/classes.tif --nodata 0

    # Vectorise only the two highest classes:
    python3 convert-tif-to-geojson.py tif/classes.tif --classes 6,7

    # Keep the source CRS instead of reprojecting to WGS84:
    python3 convert-tif-to-geojson.py tif/classes.tif --no-reproject

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-tif-to-geojson.py tif/classes.tif

Nodata: the raster's own nodata tag is used when it has one. Many classified
rasters don't set it (the reference file doesn't) and rely on convention
instead, so the fallback is 255 — override with ``--nodata`` when it differs.

The GeoJSON is an **intermediate**, not something the app fetches: the frontend
never loads ``.geojson`` in production. Convert it onward, e.g.

    python3 convert-geojson-to-pmtiles.py tif/classes.geojson

and then add the result to ``configs/<project>/layers.json``, styling on the
``class`` property:

    {
      "id": "my-classes",
      "name": "My classes",
      "source": "https://data.woonzorglimburg.nl/pmtiles/classes.pmtiles",
      "format": "pmtiles",
      "geostyler": {
        "name": "class",
        "rules": [
          {
            "name": "Klasse 1",
            "filter": ["==", "class", 1],
            "symbolizers": [{ "kind": "Fill", "color": "#d7f0b2" }]
          },
          {
            "name": "Klasse 2",
            "filter": ["==", "class", 2],
            "symbolizers": [{ "kind": "Fill", "color": "#98a86a" }]
          }
        ]
      }
    }
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape

HERE = Path(__file__).resolve().parent
TIF_SUFFIXES = (".tif", ".tiff")

# Classified rasters commonly leave the nodata tag unset and mark nodata with a
# sentinel by convention. 255 is the usual one for uint8 class rasters.
DEFAULT_NODATA = 255

# Visvalingam retention, as a percentage of vertices kept. 10 was measured as a
# good balance on a 5 m raster: ~10x smaller with 0.08% area drift.
DEFAULT_SIMPLIFY = 10.0

# GeoJSON coordinate precision in degrees; ~0.1 m, well below a 5 m cell.
WGS84_PRECISION = 0.000001

# Precision for projected output (--no-reproject), in the CRS's own units —
# metres for RD New and Web Mercator, so 0.01 is centimetres.
PROJECTED_PRECISION = 0.01


def parse_classes(value: str) -> list[int]:
    """Parse a "1,2,3" class allow-list into a list of ints."""
    values = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            values.append(int(part))
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"--classes expects integer class values, got {part!r}"
            ) from None
    if not values:
        raise argparse.ArgumentTypeError("--classes given but no values parsed")
    return values


def parse_simplify(value: str) -> float:
    """Parse the --simplify percentage, which must be in (0, 100]."""
    try:
        pct = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"--simplify expects a number, got {value!r}"
        ) from None
    if not 0 < pct <= 100:
        raise argparse.ArgumentTypeError(
            f"--simplify must be >0 and <=100 (percent of vertices kept), got {pct}"
        )
    return pct


def find_mapshaper() -> list[str]:
    """Return the command prefix that runs mapshaper, or explain how to get it.

    Prefers a global/local ``mapshaper`` binary and falls back to ``npx``, which
    resolves the copy in the repo's node_modules. Kept out of module scope so
    ``--help`` and argument validation still work without Node installed.
    """
    direct = shutil.which("mapshaper")
    if direct:
        return [direct]

    npx = shutil.which("npx")
    if npx:
        return [npx, "mapshaper"]

    raise SystemExit(
        "error: this script needs 'mapshaper' to simplify geometries without\n"
        "       breaking topology, but neither 'mapshaper' nor 'npx' is on PATH.\n"
        "  install:  npm install -g mapshaper\n"
        "  (or run from a checkout where node/npx is available)"
    )


def polygonize(
    input_path: Path,
    *,
    band: int,
    nodata: int | None,
    classes: list[int] | None,
    connectivity: int,
) -> tuple[gpd.GeoDataFrame, object]:
    """Vectorise one band of a classified raster into per-region polygons.

    Returns the GeoDataFrame and the source CRS. Cells equal to ``nodata`` are
    excluded, as are cells outside ``classes`` when that allow-list is given.
    """
    with rasterio.open(input_path) as src:
        if band < 1 or band > src.count:
            raise SystemExit(
                f"error: --band {band} is out of range, "
                f"{input_path.name} has {src.count} band(s)"
            )
        data = src.read(band)
        transform = src.transform
        crs = src.crs
        file_nodata = src.nodata

    if crs is None:
        raise SystemExit(
            f"error: {input_path.name} has no CRS, so the output cannot be "
            "georeferenced. Assign one with gdal_edit.py -a_srs EPSG:XXXX first."
        )

    # An explicit --nodata wins; otherwise use the file's tag, and fall back to
    # the 255 convention when it has none (the common case for class rasters).
    if nodata is None:
        nodata = int(file_nodata) if file_nodata is not None else DEFAULT_NODATA
        source = "file tag" if file_nodata is not None else "convention"
        print(f"Nodata value: {nodata} ({source})")
    else:
        print(f"Nodata value: {nodata} (--nodata)")

    mask = data != nodata
    if classes is not None:
        mask &= np.isin(data, classes)

    kept = int(mask.sum())
    if kept == 0:
        raise SystemExit(
            "error: no cells left to vectorise — every cell is nodata or was "
            "excluded by --classes."
        )
    print(
        f"Vectorising {kept:,} of {data.size:,} cells "
        f"({kept / data.size:.1%}), connectivity {connectivity}…"
    )

    geometries = []
    values = []
    for geom, value in shapes(
        data, mask=mask, transform=transform, connectivity=connectivity
    ):
        geometries.append(shape(geom))
        values.append(int(value))

    # Field names are lowercased here as in the other converters in this folder.
    gdf = gpd.GeoDataFrame({"class": values}, geometry=geometries, crs=crs)
    present = sorted(set(values))
    print(f"  {len(gdf):,} regions, classes {present}")
    return gdf, crs


def tag_crs(path: Path, crs: str) -> None:
    """Insert a GeoJSON ``crs`` member naming ``crs`` into ``path``.

    Only needed for projected output: a GeoJSON with no ``crs`` member is WGS84
    by RFC 7946, so coordinates in metres would otherwise be read as degrees.
    The member is deprecated by that RFC but is still how GDAL/OGR and GeoPandas
    recover a non-WGS84 CRS, and it is what they write themselves.
    """
    authority = crs.replace("EPSG:", "") if crs.startswith("EPSG:") else None
    if authority is None:
        print(f"  warning: cannot tag non-EPSG CRS '{crs}' in the GeoJSON")
        return

    member = (
        '{"type":"FeatureCollection",'
        '"crs":{"type":"name","properties":'
        f'{{"name":"urn:ogc:def:crs:EPSG::{authority}"}}}},'
    )
    original = f'{{"type":"FeatureCollection",'

    # mapshaper opens the file with this exact prefix; rewrite just the head and
    # stream the rest so a large output is never held in memory.
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(path, "r", encoding="utf-8") as src:
        head = src.read(len(original))
        if head != original:
            print("  warning: unexpected GeoJSON header, CRS not tagged")
            return
        with open(temporary, "w", encoding="utf-8") as dst:
            dst.write(member)
            shutil.copyfileobj(src, dst)

    temporary.replace(path)
    print(f"  tagged output as {crs}")


def simplify_with_mapshaper(
    source_path: Path,
    output_path: Path,
    *,
    source_crs: str,
    simplify: float,
    reproject: bool,
) -> None:
    """Simplify with shared-arc topology preserved, then write the output.

    Neighbouring regions keep exactly coincident borders because mapshaper
    simplifies each shared arc once rather than once per polygon.
    """
    command = find_mapshaper() + [str(source_path)]

    if simplify < 100:
        # keep-shapes stops small regions being simplified away entirely.
        command += [
            "-simplify",
            "visvalingam",
            f"percentage={simplify}%",
            "keep-shapes",
        ]
        print(f"Simplifying to {simplify:g}% of vertices (topology-preserving)…")
    else:
        print("Simplification disabled (--simplify 100), cleaning only…")

    # Repairs any self-intersection simplification may have introduced.
    command += ["-clean"]

    if reproject:
        # mapshaper does not read the GeoJSON 'crs' member, so the source has to
        # be stated explicitly — without from= it fails with "source coordinate
        # system is unknown".
        command += ["-proj", f"from={source_crs}", "wgs84"]
        print(f"Reprojecting {source_crs} -> EPSG:4326…")

    # Coordinate precision is in the output CRS's units: degrees after
    # reprojection, but the source's own units (metres, for RD New) without it.
    precision = WGS84_PRECISION if reproject else PROJECTED_PRECISION
    command += ["-o", f"precision={precision}", str(output_path)]

    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    # mapshaper reports progress on stderr even when it succeeds.
    for line in (result.stderr or "").splitlines():
        if line.strip():
            print(f"  {line}")

    if result.returncode != 0:
        print(
            f"error: mapshaper failed (exit {result.returncode})",
            file=sys.stderr,
        )
        if result.stdout.strip():
            print(result.stdout, file=sys.stderr)
        raise SystemExit(1)

    if not reproject:
        # mapshaper writes no 'crs' member, and a GeoJSON without one means
        # WGS84 by RFC 7946 — so projected output would be read as degrees.
        # Re-declare the CRS so readers see the real one.
        tag_crs(output_path, source_crs)


def convert(
    input_path: Path,
    output_path: Path,
    *,
    band: int,
    nodata: int | None,
    classes: list[int] | None,
    connectivity: int,
    simplify: float,
    reproject: bool,
    keep_intermediate: bool,
) -> None:
    """Polygonize ``input_path`` and write simplified GeoJSON to ``output_path``."""
    gdf, crs = polygonize(
        input_path,
        band=band,
        nodata=nodata,
        classes=classes,
        connectivity=connectivity,
    )

    source_crs = crs.to_string()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        if keep_intermediate:
            intermediate = output_path.with_suffix(".raw.geojson")
        else:
            intermediate = Path(tmpdir) / "polygonized.geojson"

        print(f"Writing intermediate ({source_crs})…")
        gdf.to_file(intermediate, driver="GeoJSON")
        print(f"  {intermediate.stat().st_size:,} bytes")

        simplify_with_mapshaper(
            intermediate,
            output_path,
            source_crs=source_crs,
            simplify=simplify,
            reproject=reproject,
        )

        if keep_intermediate:
            print(f"Kept intermediate: {intermediate.name}")

    size = output_path.stat().st_size
    final_crs = "EPSG:4326" if reproject else source_crs
    print(
        f"Wrote {output_path.name} ({size:,} bytes) — "
        f"{len(gdf):,} features, {final_crs}"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a classified GeoTIFF to GeoJSON polygons, simplified "
            "without breaking topology between neighbouring raster cells."
        ),
    )
    parser.add_argument(
        "input",
        help="Input .tif path (a classified integer raster)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="Output .geojson path (default: input path with .geojson suffix)",
    )
    parser.add_argument(
        "--simplify",
        type=parse_simplify,
        default=DEFAULT_SIMPLIFY,
        metavar="PCT",
        help=(
            "Percentage of vertices to keep (Visvalingam). "
            f"Default {DEFAULT_SIMPLIFY:g}; 100 disables simplification."
        ),
    )
    parser.add_argument(
        "--nodata",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Cell value to treat as nodata (default: the raster's nodata tag, "
            f"or {DEFAULT_NODATA} when it has none)"
        ),
    )
    parser.add_argument(
        "--classes",
        type=parse_classes,
        default=None,
        metavar="1,2,3",
        help="Only vectorise these class values (default: all non-nodata values)",
    )
    parser.add_argument(
        "--band",
        type=int,
        default=1,
        metavar="N",
        help="Band to vectorise (default: 1)",
    )
    parser.add_argument(
        "--connectivity",
        type=int,
        choices=(4, 8),
        default=4,
        help=(
            "Cell connectivity when grouping regions: 4 = edges only "
            "(default), 8 = edges and corners"
        ),
    )
    parser.add_argument(
        "--no-reproject",
        dest="reproject",
        action="store_false",
        help="Keep the source CRS instead of reprojecting to WGS84",
    )
    parser.add_argument(
        "--keep-intermediate",
        action="store_true",
        help="Also write the unsimplified polygons as <output>.raw.geojson",
    )
    args = parser.parse_args(argv[1:])

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if not input_path.is_file():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 2
    if input_path.suffix.lower() not in TIF_SUFFIXES:
        print(
            f"error: expected a GeoTIFF {TIF_SUFFIXES}, got '{input_path.suffix}'",
            file=sys.stderr,
        )
        return 2

    if args.output is not None:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".geojson")

    convert(
        input_path,
        output_path,
        band=args.band,
        nodata=args.nodata,
        classes=args.classes,
        connectivity=args.connectivity,
        simplify=args.simplify,
        reproject=args.reproject,
        keep_intermediate=args.keep_intermediate,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
