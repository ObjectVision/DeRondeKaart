#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "numpy>=1.24",
#   "pandas>=2.0",
#   "pyarrow>=15",
#   "tqdm>=4.66",
# ]
# ///
"""Convert a GeoJSON file to Parquet with GeoArrow-encoded geometry (not WKB).

Unlike ``convert-geojson-to-geoparquet.py`` (which writes WKB-encoded geometry
consumed via the ``"geoparquet"`` format), this script writes geometry using
GeoParquet 1.1's **native GeoArrow encoding**. Those files are rendered by this
app through the ``"parquet"`` format entry in ``public/layers.json`` — the path
that reads with ``parquet-wasm`` directly (no WKB→GeoArrow conversion), which
supports HTTP Range / streaming reads.

Accepts either a single ``.geojson``/``.json`` file **or a folder**: when a
folder is given, every ``*.geojson``/``*.json`` in it is converted (each
``name.geojson`` -> ``name.parquet`` beside it, or into an optional output
folder), with a tqdm progress bar.

Field names are lowercased and numeric fields are narrowed to the smallest type
their values fit in (see ``downcast_numeric``): float64 -> float32, and
integers -> the narrowest (u)int8/16/32/64. Types are inferred **per file**, so
the same logical field can land on different types in different files — that is
fine for the app (JS reads every int/float width as a plain number) with one
exception: boolean. Pass ``--no-bool`` to keep 0/1 columns as integers; see the
warning printed when a column is narrowed to boolean.

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

    # Whole folder -> one .parquet per .geojson, written alongside the inputs:
    python3 convert-geojson-to-parquet.py path/to/folder
    # ...or to a separate output folder:
    python3 convert-geojson-to-parquet.py path/to/folder path/to/out_folder

    # Custom batch size (rows per Parquet row group):
    python3 convert-geojson-to-parquet.py --batch-size 10000

    # Never infer boolean from 0/1 integer columns:
    python3 convert-geojson-to-parquet.py path/to/folder --no-bool

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
import numpy as np
import pandas as pd
from shapely.geometry.polygon import orient
from tqdm import tqdm


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "ov.geojson"
GEOJSON_SUFFIXES = (".geojson", ".json")

# Rows per Parquet row group = streaming batch size for the web reader.
# See the module docstring for why 20,000 is a good web default.
DEFAULT_BATCH_SIZE = 20_000

# Integer downcast candidates, narrowest first. Unsigned is tried first for
# non-negative columns: same width, twice the positive range.
UINT_DTYPES = ("uint8", "uint16", "uint32", "uint64")
INT_DTYPES = ("int8", "int16", "int32", "int64")
FLOAT32_MAX = float(np.finfo(np.float32).max)


def narrowest_int_dtype(vmin: int, vmax: int) -> str | None:
    """Smallest numpy integer dtype holding ``[vmin, vmax]``, or None if none does."""
    if vmin >= 0:
        for name in UINT_DTYPES:
            if vmax <= np.iinfo(name).max:
                return name
        return None
    for name in INT_DTYPES:
        info = np.iinfo(name)
        if vmin >= info.min and vmax <= info.max:
            return name
    return None


def nullable_name(np_name: str) -> str:
    """numpy int dtype name -> pandas nullable equivalent ("uint8" -> "UInt8")."""
    return "UInt" + np_name[4:] if np_name.startswith("uint") else "Int" + np_name[3:]


def to_narrow_int(s: pd.Series, allow_bool: bool = True) -> pd.Series | None:
    """Narrow a whole-number series to its smallest integer dtype.

    Returns None when the series is already at its narrowest (or has no values).
    Columns holding nulls get the pandas *nullable* dtype ("Int8"), so the null
    survives into Arrow as a null rather than a sentinel value.
    """
    nonnull = s.dropna()
    if nonnull.empty:
        return None
    vmin, vmax = int(nonnull.min()), int(nonnull.max())
    has_null = bool(s.isna().any())

    # Two-state flag: both 0 and 1 present and nothing else. Requiring BOTH is
    # deliberate — an all-zero (or all-one) column also "fits" a bool, but it is
    # far more likely to be an ordinal/count field that happens to be constant in
    # this one file, and typing it bool would change its meaning app-side.
    if allow_bool and vmin == 0 and vmax == 1 and len(nonnull.unique()) == 2:
        target = "boolean" if has_null else "bool"
    else:
        name = narrowest_int_dtype(vmin, vmax)
        if name is None:
            return None  # outside every fixed-width integer range — leave as is
        target = nullable_name(name) if has_null else name

    if str(s.dtype) == target:
        return None
    # Route through a 64-bit integer: float -> bool would go via truthiness, and
    # float -> nullable int needs the NaN -> NA step.
    base = s.astype("Int64") if has_null else s.astype("int64")
    return base.astype(target)


def downcast_series(s: pd.Series, allow_bool: bool = True) -> pd.Series | None:
    """Narrowest lossless numeric dtype for one column, or None to leave it alone."""
    if pd.api.types.is_bool_dtype(s):
        return None  # already 1 bit
    if pd.api.types.is_integer_dtype(s):
        return to_narrow_int(s, allow_bool)
    if not pd.api.types.is_float_dtype(s):
        return None  # strings, dates, geometry, ...

    nonnull = s.dropna()
    if nonnull.empty:
        return None
    arr = nonnull.to_numpy(dtype="float64")
    finite = arr[np.isfinite(arr)]

    # A float64 column whose values are all whole numbers is what pandas gives an
    # *integer* GeoJSON field that has nulls. An int dtype is both narrower than
    # float32 and lossless, so prefer it (JS still reads the values as numbers).
    if len(finite) == len(arr) and np.all(arr == np.floor(arr)):
        narrowed = to_narrow_int(s, allow_bool)
        if narrowed is not None:
            return narrowed

    if s.dtype == np.float32:
        return None
    if len(finite) and np.abs(finite).max() > FLOAT32_MAX:
        return None  # float32 would round these to inf — keep the wider type
    return s.astype("float32")


def downcast_numeric(gdf: gpd.GeoDataFrame, log=print, allow_bool: bool = True) -> gpd.GeoDataFrame:
    """Narrow every numeric field to the smallest type its values fit in.

    float64 -> float32, integers -> the narrowest (u)int width. The geometry
    column is never touched.

    Expect little to no change in *file* size on geometry-heavy layers: the
    geometry column dominates the bytes, and snappy already squeezes a
    low-cardinality int32 column down to about what a uint8 one costs. The win
    is client-side and in RAM — the decoded Arrow column is a flat typed array,
    so uint8 really is 1 byte per feature against int32's 4 and float32's 4
    against float64's 8. Layers with many float64 attribute columns benefit
    most.
    """
    geom_name = gdf.geometry.name
    changes: list[str] = []
    booled: list[str] = []

    for col in gdf.columns:
        if col == geom_name:
            continue
        before = str(gdf[col].dtype)
        narrowed = downcast_series(gdf[col], allow_bool)
        if narrowed is None:
            continue
        gdf[col] = narrowed
        changes.append(f"{col} {before}->{narrowed.dtype}")
        if str(narrowed.dtype) in ("bool", "boolean"):
            booled.append(col)

    if changes:
        log(f"  Narrowed {len(changes)} field(s): " + ", ".join(changes))
    if booled:
        # Worth shouting about: unlike an int width change, this one is visible to
        # the app. Arrow bool reads back as JS true/false, so String(value) yields
        # "true"/"false" — chart labels keyed on "0"/"1" (public/charts.json) stop
        # matching. GeoStyler filters still work (JS coerces true==1, false<5).
        log(
            f"  WARNING: {', '.join(booled)} -> boolean (only 0/1 in this file). "
            "Charts grouping on these keys by \"true\"/\"false\", not \"0\"/\"1\". "
            "Re-run with --no-bool to keep them integers."
        )
    return gdf


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


def convert(
    input_path: Path,
    output_path: Path,
    batch_size: int,
    log=print,
    allow_bool: bool = True,
) -> None:
    """Convert one GeoJSON file to GeoArrow-encoded Parquet.

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

    # Shrink numeric fields to their narrowest lossless type before writing.
    gdf = downcast_numeric(gdf, log=log, allow_bool=allow_bool)

    row_groups = max(1, -(-len(gdf) // batch_size))  # ceil division
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log(
        f"Writing  {output_path} (GeoArrow encoding, "
        f"batch_size={batch_size:,} -> ~{row_groups} row group(s))"
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
    log(f"Wrote {output_path.name} ({size:,} bytes)")


def convert_folder(
    input_dir: Path,
    output_dir: Path,
    batch_size: int,
    allow_bool: bool = True,
) -> int:
    """Convert every GeoJSON in ``input_dir`` to Parquet in ``output_dir``.

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
            convert(path, out, batch_size, log=tqdm.write, allow_bool=allow_bool)
        except Exception as err:  # keep going through the batch
            failures += 1
            tqdm.write(f"error converting {path.name}: {err}")

    done = len(files) - failures
    print(f"Done: {done}/{len(files)} converted" + (f", {failures} failed" if failures else ""))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert GeoJSON to Parquet with GeoArrow-encoded geometry.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default=str(DEFAULT_INPUT),
        help=(
            f"Input GeoJSON path or folder of GeoJSONs (default: {DEFAULT_INPUT.name})"
        ),
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help=(
            "Output Parquet path, or output folder in folder mode "
            "(default: input path with .parquet suffix / alongside the inputs)"
        ),
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
    parser.add_argument(
        "--no-bool",
        action="store_true",
        help="Never narrow 0/1 integer columns to boolean",
    )
    args = parser.parse_args(argv[1:])

    if args.batch_size < 1:
        print("error: --batch-size must be >= 1", file=sys.stderr)
        return 2
    allow_bool = not args.no_bool

    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    # Folder mode: convert every GeoJSON in the folder.
    if input_path.is_dir():
        if args.output is not None:
            output_dir = Path(args.output)
            if not output_dir.is_absolute():
                output_dir = (Path.cwd() / output_dir).resolve()
        else:
            output_dir = input_path  # write .parquet alongside the inputs
        return convert_folder(
            input_path, output_dir, args.batch_size, allow_bool=allow_bool
        )

    # Single-file mode.
    if args.output is not None:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".parquet")

    convert(input_path, output_path, args.batch_size, allow_bool=allow_bool)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
