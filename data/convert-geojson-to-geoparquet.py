#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "pyarrow>=15",
# ]
# ///
"""Convert a GeoJSON file to GeoParquet (WKB-encoded geometry, GeoParquet 1.1 spec).

The output is a standard GeoParquet file that this app renders via the
``"geoparquet"`` format entry in ``public/layers.json`` — i.e. the same path
that handles the existing ``example-polygons`` layer.

Usage:
    # Default: convert data/vrz_limburg_2026.geojson → data/vrz_limburg_2026.parquet
    python3 convert-geojson-to-geoparquet.py

    # Explicit input/output:
    python3 convert-geojson-to-geoparquet.py path/to/in.geojson path/to/out.parquet

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-geojson-to-geoparquet.py

After conversion, add to ``public/layers.json`` like:
    {
      "id": "vrz-limburg",
      "name": "VRZ Limburg 2026",
      "source": "https://data.woonzorglimburg.nl/parquet/vrz_limburg_2026.parquet",
      "format": "geoparquet",
      "geometryType": "polygon",
      "style": { "opacity": 0.8 }
    }
"""
from __future__ import annotations

import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry.polygon import orient


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "vrz_limburg_2026.geojson"


def normalize_winding(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Orient (multi)polygon rings to RFC 7946 (exterior CCW, holes CW).

    deck.gl's GeoArrow polygon tessellation produces sliver/bridge artefacts for
    inverse-mask donut polygons whose rings have non-standard winding. shapely's
    ``orient(sign=1.0)`` fixes Polygon and MultiPolygon; other geometry types
    (points/lines) pass through unchanged.
    """
    gdf = gdf.copy()
    gdf.geometry = gdf.geometry.apply(
        lambda g: orient(g, sign=1.0)
        if g is not None and g.geom_type in ("Polygon", "MultiPolygon")
        else g
    )
    return gdf


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

    # Normalize ring winding so deck.gl tessellates donut/mask polygons without
    # bridge-sliver artefacts (see normalize_winding docstring).
    gdf = normalize_winding(gdf)

    # GeoPandas writes a GeoParquet 1.1 file with WKB-encoded geometry by
    # default, which is exactly what @geoarrow/geoparquet-wasm consumes.
    print(f"Writing  {output_path}")
    gdf.to_parquet(output_path, compression="snappy", index=False)

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
