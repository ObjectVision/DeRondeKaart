#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "pyarrow>=15",
#   "tqdm>=4.66",
# ]
# ///
"""Convert GeoJSON to GeoParquet (WKB-encoded geometry, GeoParquet 1.1 spec).

The output is a standard GeoParquet file that this app renders via the
``"geoparquet"`` format entry in ``public/layers.json`` — i.e. the same path
that handles the existing ``example-polygons`` layer.

Accepts either a single ``.geojson``/``.json`` file **or a folder**: when a
folder is given, every ``*.geojson``/``*.json`` in it is converted (each
``name.geojson`` -> ``name.parquet`` beside it), with a tqdm progress bar.

Usage:
    # Default: convert data/vrz_limburg_2026.geojson -> data/vrz_limburg_2026.parquet
    python3 convert-geojson-to-geoparquet.py

    # Single file, explicit input/output:
    python3 convert-geojson-to-geoparquet.py path/to/in.geojson path/to/out.parquet

    # Whole folder -> one .parquet per .geojson, written alongside the inputs:
    python3 convert-geojson-to-geoparquet.py path/to/folder
    # ...or to a separate output folder:
    python3 convert-geojson-to-geoparquet.py path/to/folder path/to/out_folder

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
from tqdm import tqdm


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "vrz_limburg_2026.geojson"
GEOJSON_SUFFIXES = (".geojson", ".json")


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


def convert(input_path: Path, output_path: Path, log=print) -> None:
    """Convert one GeoJSON file to GeoParquet.

    ``log`` is the sink for progress messages — ``print`` for single-file mode,
    ``tqdm.write`` in folder mode so it doesn't corrupt the progress bar.
    """
    log(f"Reading  {input_path}")
    gdf = gpd.read_file(input_path)

    # Drop features with null/empty geometry: they can't be rendered by deck.gl,
    # and their geom_type is NaN (a float) which breaks sorting/orientation below.
    missing = gdf.geometry.isna() | gdf.geometry.is_empty
    if missing.any():
        log(f"  Dropping {int(missing.sum())} feature(s) with null/empty geometry")
        gdf = gdf[~missing].copy()

    geom_types = sorted(gdf.geom_type.dropna().unique())
    log(f"  {len(gdf)} features, CRS={gdf.crs}, geometry types={geom_types}")

    # The app's deck.gl rendering expects WGS84 (EPSG:4326) coordinates.
    if gdf.crs is None:
        log("  Warning: input has no CRS — assuming EPSG:4326")
        gdf = gdf.set_crs(epsg=4326)
    elif gdf.crs.to_epsg() != 4326:
        log(f"  Reprojecting from {gdf.crs} to EPSG:4326")
        gdf = gdf.to_crs(epsg=4326)

    # Normalize ring winding so deck.gl tessellates donut/mask polygons without
    # bridge-sliver artefacts (see normalize_winding docstring).
    gdf = normalize_winding(gdf)

    # Export all field names in lowercase. Rename every column, then re-point the
    # active geometry column at its new (lowercased) name so the geometry
    # association survives the rename.
    geom_name = gdf.geometry.name
    lowered = {c: c.lower() for c in gdf.columns}
    dupes = [v for v in lowered.values() if list(lowered.values()).count(v) > 1]
    if dupes:
        log(f"  Warning: lowercasing collides on {sorted(set(dupes))}; keeping originals")
    else:
        gdf = gdf.rename(columns=lowered)
        gdf = gdf.set_geometry(geom_name.lower())

    # GeoPandas writes a GeoParquet 1.1 file with WKB-encoded geometry by
    # default, which is exactly what @geoarrow/geoparquet-wasm consumes.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log(f"Writing  {output_path}")
    gdf.to_parquet(output_path, compression="snappy", index=False)

    size = output_path.stat().st_size
    log(f"Wrote {output_path.name} ({size:,} bytes)")


def convert_folder(input_dir: Path, output_dir: Path) -> int:
    """Convert every GeoJSON in ``input_dir`` to GeoParquet in ``output_dir``.

    Returns the number of files that failed (0 on full success).
    """
    files = sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in GEOJSON_SUFFIXES
    )
    if not files:
        print(f"error: no .geojson/.json files found in {input_dir}", file=sys.stderr)
        return 1

    print(f"Converting {len(files)} file(s) from {input_dir} -> {output_dir}")
    failures = 0
    for path in tqdm(files, unit="file", desc="Converting"):
        out = output_dir / (path.stem + ".parquet")
        try:
            convert(path, out, log=tqdm.write)
        except Exception as err:  # keep going through the batch
            failures += 1
            tqdm.write(f"error converting {path.name}: {err}")

    done = len(files) - failures
    print(f"Done: {done}/{len(files)} converted" + (f", {failures} failed" if failures else ""))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if len(argv) > 3:
        print(__doc__)
        return 2

    input_path = Path(argv[1]) if len(argv) >= 2 else DEFAULT_INPUT
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    # Folder mode: convert every GeoJSON in the folder.
    if input_path.is_dir():
        if len(argv) >= 3:
            output_dir = Path(argv[2])
            if not output_dir.is_absolute():
                output_dir = (Path.cwd() / output_dir).resolve()
        else:
            output_dir = input_path  # write .parquet alongside the inputs
        return convert_folder(input_path, output_dir)

    # Single-file mode.
    if len(argv) >= 3:
        output_path = Path(argv[2])
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".parquet")

    convert(input_path, output_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
