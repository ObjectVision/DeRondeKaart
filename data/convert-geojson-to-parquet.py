#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "pyarrow>=15",
# ]
# ///
"""Convert a GeoJSON file to Parquet with GeoArrow-encoded geometry (not WKB).

Unlike ``convert-geojson-to-geoparquet.py`` (which writes WKB-encoded geometry
consumed via the ``"geoparquet"`` format), this script writes geometry using
GeoParquet 1.1's **native GeoArrow encoding**. Those files are rendered by this
app through the ``"parquet"`` format entry in ``public/layers.json`` — the path
that reads with ``parquet-wasm`` directly (no WKB→GeoArrow conversion), which
supports HTTP Range / streaming reads.

Batch size (Parquet row-group size)
-----------------------------------
A Parquet *row group* is the unit of streaming: when the app reads a ``"parquet"``
layer it issues HTTP 206 (partial content) range requests and the
``readParquetStream`` reader emits **one batch per row group**. So the row-group
size directly controls progressive web loading:

  * One giant row group (pyarrow's default is ~1,048,576 rows) → the whole file
    arrives as a single batch: no incremental render, peak memory = whole file.
  * Tiny row groups → many small HTTP requests (per-request overhead) and worse
    compression.

For web partial-loading the sweet spot is a few thousand–tens of thousands of
features per row group: small enough that the first batch paints quickly and
memory stays bounded, large enough to keep the request count and compression
sensible. We default to **20,000**, which leaves the small point layers in this
project (hundreds–few-thousand features) as a single batch (no overhead) while
splitting large polygon datasets into a handful of progressively-rendered
batches. Tune with ``--batch-size`` if your layer is much larger or denser.

Usage:
    # Default: convert data/ov.geojson → data/ov.parquet (20k rows/group)
    python3 convert-geojson-to-parquet.py

    # Explicit input/output:
    python3 convert-geojson-to-parquet.py path/to/in.geojson path/to/out.parquet

    # Custom batch size (rows per Parquet row group):
    python3 convert-geojson-to-parquet.py --batch-size 10000

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-geojson-to-parquet.py

After conversion, add to ``public/layers.json`` like:
    {
      "id": "ov",
      "name": "OV",
      "source": "https://data.woonzorglimburg.nl/parquet/ov.parquet",
      "format": "parquet",
      "geometryType": "polygon",
      "style": { "opacity": 0.8 }
    }
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import geopandas as gpd


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "ov.geojson"

# Rows per Parquet row group = streaming batch size for the web reader.
# See the module docstring for why 20,000 is a good web default.
DEFAULT_BATCH_SIZE = 20_000


def convert(input_path: Path, output_path: Path, batch_size: int) -> None:
    print(f"Reading  {input_path}")
    gdf = gpd.read_file(input_path)
    print(f"  {len(gdf)} features, CRS={gdf.crs}, geometry types={sorted(gdf.geom_type.unique())}")

    # The app's deck.gl rendering expects WGS84 (EPSG:4326) coordinates.
    if gdf.crs is None:
        print("  Warning: input has no CRS — assuming EPSG:4326")
        gdf = gdf.set_crs(epsg=4326)
    elif gdf.crs.to_epsg() != 4326:
        print(f"  Reprojecting from {gdf.crs} to EPSG:4326")
        gdf = gdf.to_crs(epsg=4326)

    row_groups = max(1, -(-len(gdf) // batch_size))  # ceil division
    print(
        f"Writing  {output_path} (GeoArrow encoding, "
        f"batch_size={batch_size:,} → ~{row_groups} row group(s))"
    )
    # geometry_encoding="geoarrow" writes the geometry column using GeoParquet
    # 1.1's native GeoArrow encoding (separated/interleaved coordinates) instead
    # of WKB. This is what parquet-wasm reads directly for the "parquet" format.
    # row_group_size sets the streaming batch size (passed through to pyarrow).
    gdf.to_parquet(
        output_path,
        compression="snappy",
        geometry_encoding="geoarrow",
        row_group_size=batch_size,
        index=False,
    )

    size = output_path.stat().st_size
    print(f"Wrote {output_path.name} ({size:,} bytes)")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert GeoJSON to Parquet with GeoArrow-encoded geometry.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default=str(DEFAULT_INPUT),
        help=f"Input GeoJSON path (default: {DEFAULT_INPUT.name})",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="Output Parquet path (default: input path with .parquet suffix)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        metavar="ROWS",
        help=(
            "Rows per Parquet row group = streaming batch size for the web "
            f"reader (default: {DEFAULT_BATCH_SIZE:,})"
        ),
    )
    args = parser.parse_args(argv[1:])

    if args.batch_size < 1:
        print("error: --batch-size must be >= 1", file=sys.stderr)
        return 2

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if args.output is not None:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".parquet")

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    convert(input_path, output_path, args.batch_size)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
