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

Usage:
    # Default: convert data/ov.geojson → data/ov.parquet
    python3 convert-geojson-to-parquet.py

    # Explicit input/output:
    python3 convert-geojson-to-parquet.py path/to/in.geojson path/to/out.parquet

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

import sys
from pathlib import Path

import geopandas as gpd


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "ov.geojson"


def convert(input_path: Path, output_path: Path) -> None:
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

    # geometry_encoding="geoarrow" writes the geometry column using GeoParquet
    # 1.1's native GeoArrow encoding (separated/interleaved coordinates) instead
    # of WKB. This is what parquet-wasm reads directly for the "parquet" format.
    print(f"Writing  {output_path} (GeoArrow encoding)")
    gdf.to_parquet(
        output_path,
        compression="snappy",
        geometry_encoding="geoarrow",
        index=False,
    )

    size = output_path.stat().st_size
    print(f"Wrote {output_path.name} ({size:,} bytes)")


def main(argv: list[str]) -> int:
    if len(argv) > 3:
        print(__doc__)
        return 2

    input_path = Path(argv[1]) if len(argv) >= 2 else DEFAULT_INPUT
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if len(argv) >= 3:
        output_path = Path(argv[2])
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".parquet")

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    convert(input_path, output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
