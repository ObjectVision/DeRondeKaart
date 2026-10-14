#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "pandas>=2.0",
#   "pyogrio>=0.7",
#   "shapely>=2.0",
# ]
# ///
"""Convert one or more ESRI Shapefiles to a single GeoJSON — the vector intake.

This is the shapefile counterpart to ``convert-tif-to-geojson.py``: both turn a
legacy source (MapServer ``DATA`` shapefiles and grids) into the WGS84 GeoJSON
intermediate that the ``convert-geojson-to-*.py`` converters in this folder
take onward to PMTiles, FlatGeobuf or (Geo)Parquet.

Several inputs are **concatenated** into one output. That is the point of
accepting more than one: data that the old MapServer setup kept per region
(``vector/<region>/APO_m5.shp``, selected with a ``%data%`` substitution) is
merged into one layer here, so the map shows every region at once. Inputs must
share their attribute schema closely enough to stack; columns missing from one
input come out as null for its features.

Field names are lowercased, as in the other converters. Output is reprojected
to WGS84 (EPSG:4326), as RFC 7946 requires; a shapefile without a ``.prj`` is
an error unless ``--assume-crs`` says what it is.

The GeoJSON is an **intermediate**, not something the app fetches. Convert it
onward, e.g.

    python3 convert-geojson-to-pmtiles.py out.geojson out.pmtiles

Usage:
    # One shapefile -> GeoJSON next to it
    python3 convert-shapefile-to-geojson.py vector/twente/APO_m5.shp

    # Several regions merged into one GeoJSON, tagging each feature's origin
    python3 convert-shapefile-to-geojson.py \\
        vector/twente/APO_m5.shp vector/achterhoek/APO_m5.shp \\
        -o APO_m5.geojson --add-region

    # Every .shp in a folder, keeping only classified features
    python3 convert-shapefile-to-geojson.py vector/twente -o twente.geojson \\
        --where "score > 0"

    # Add a constant attribute to every feature
    python3 convert-shapefile-to-geojson.py in.shp -o out.geojson \\
        --add-field bron=top10nl

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-shapefile-to-geojson.py vector/twente/APO_m5.shp
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd

# GeoJSON coordinate precision in decimal places of a degree; 6 is ~0.1 m.
DEFAULT_PRECISION = 6

TARGET_CRS = "EPSG:4326"


def collect_inputs(paths: list[Path]) -> list[Path]:
    """Expand folders to their ``.shp`` files, keeping the given order."""
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            found = sorted(p for p in path.iterdir() if p.suffix.lower() == ".shp")
            if not found:
                raise SystemExit(f"error: no .shp files in folder {path}")
            files.extend(found)
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f"error: input not found: {path}")
    return files


def parse_add_field(value: str) -> tuple[str, str]:
    """Parse ``NAME=VALUE`` for --add-field."""
    name, sep, val = value.partition("=")
    if not sep or not name.strip():
        raise argparse.ArgumentTypeError(f"--add-field expects NAME=VALUE, got {value!r}")
    return name.strip().lower(), val


def read_one(
    path: Path,
    *,
    where: str | None,
    assume_crs: str | None,
    add_region: bool,
    extra: dict[str, str],
) -> gpd.GeoDataFrame:
    """Read one shapefile, filter it, lowercase its fields and reproject it."""
    gdf = gpd.read_file(path, engine="pyogrio", where=where)

    if gdf.crs is None:
        if assume_crs is None:
            raise SystemExit(
                f"error: {path.name} has no CRS (.prj missing). "
                "Pass --assume-crs EPSG:XXXX."
            )
        gdf = gdf.set_crs(assume_crs)

    gdf = gdf.rename(
        columns={c: c.lower() for c in gdf.columns if c != gdf.geometry.name}
    )
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]

    if add_region:
        # The parent folder names the region in the MapServer layout
        # (vector/<region>/<file>.shp); the 2022 subfolder steps one higher.
        parent = path.parent
        region = parent.parent.name if parent.name.isdigit() else parent.name
        gdf["region"] = region
    for name, value in extra.items():
        gdf[name] = value

    return gdf.to_crs(TARGET_CRS)


def convert(
    inputs: list[Path],
    output_path: Path,
    *,
    where: str | None,
    assume_crs: str | None,
    add_region: bool,
    extra: dict[str, str],
    precision: int,
) -> None:
    """Read, merge and write ``inputs`` as one GeoJSON at ``output_path``."""
    frames = []
    for path in inputs:
        gdf = read_one(
            path,
            where=where,
            assume_crs=assume_crs,
            add_region=add_region,
            extra=extra,
        )
        print(f"  {path.name}: {len(gdf):,} feature(s)")
        frames.append(gdf)

    merged = gpd.GeoDataFrame(
        pd.concat(frames, ignore_index=True), crs=TARGET_CRS
    )
    if merged.empty:
        raise SystemExit("error: no features left to write")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()
    merged.to_file(
        output_path,
        driver="GeoJSON",
        engine="pyogrio",
        layer_options={"COORDINATE_PRECISION": str(precision), "RFC7946": "YES"},
    )
    size = output_path.stat().st_size
    print(
        f"Wrote {output_path.name} ({size:,} bytes) — "
        f"{len(merged):,} features from {len(inputs)} file(s), {TARGET_CRS}"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert (and merge) ESRI Shapefiles to one WGS84 GeoJSON.",
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Input .shp files and/or folders of .shp files",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        metavar="PATH",
        help="Output .geojson path (default: the single input with .geojson suffix)",
    )
    parser.add_argument(
        "--where",
        default=None,
        metavar="SQL",
        help="OGR attribute filter applied while reading, e.g. \"score > 0\"",
    )
    parser.add_argument(
        "--assume-crs",
        default=None,
        metavar="EPSG:XXXX",
        help="CRS for inputs that have no .prj (ignored when they do)",
    )
    parser.add_argument(
        "--add-region",
        action="store_true",
        help="Add a 'region' field naming each input's parent folder",
    )
    parser.add_argument(
        "--add-field",
        action="append",
        default=[],
        type=parse_add_field,
        metavar="NAME=VALUE",
        help="Add a constant string field to every feature (repeatable)",
    )
    parser.add_argument(
        "--precision",
        type=int,
        default=DEFAULT_PRECISION,
        metavar="N",
        help=f"Coordinate decimal places (default: {DEFAULT_PRECISION})",
    )
    args = parser.parse_args(argv[1:])

    inputs = collect_inputs([Path(p).resolve() for p in args.inputs])

    if args.output is not None:
        output_path = Path(args.output).resolve()
    elif len(inputs) == 1:
        output_path = inputs[0].with_suffix(".geojson")
    else:
        print("error: several inputs need an explicit -o/--output", file=sys.stderr)
        return 2

    print(f"Converting {len(inputs)} shapefile(s) -> {output_path}")
    convert(
        inputs,
        output_path,
        where=args.where,
        assume_crs=args.assume_crs,
        add_region=args.add_region,
        extra=dict(args.add_field),
        precision=args.precision,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
