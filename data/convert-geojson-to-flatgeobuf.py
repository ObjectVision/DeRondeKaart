#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "numpy>=1.24",
#   "pandas>=2.0",
#   "pyogrio>=0.7",
#   "tqdm>=4.66",
# ]
# ///
"""Convert a GeoJSON file to FlatGeobuf, with a packed Hilbert R-tree index.

FlatGeobuf is a single-file binary format for a single feature collection. Its
selling point over the Parquet variants in this folder is **spatial** streaming
rather than sequential streaming: the optional packed Hilbert R-tree index at
the head of the file lets a reader fetch the index, work out which feature
byte-ranges intersect a bounding box, and issue HTTP Range requests for only
those features. Parquet row groups stream in file order and can't be filtered by
geography that way.

The index is written **by default** here (``--no-index`` opts out); it costs on
the order of 40 bytes per feature (measured: ~2.2 kB over 50 features) and is
what makes bbox-filtered range reads possible at all.

Accepts either a single ``.geojson``/``.json`` file **or a folder**: when a
folder is given, every ``*.geojson``/``*.json`` in it is converted (each
``name.geojson`` -> ``name.fgb`` beside it, or into an optional output folder),
with a tqdm progress bar.

Field names are lowercased and numeric fields are narrowed to the smallest type
their values fit in (see ``downcast_numeric``): float64 -> float32, and
integers -> the narrowest (u)int8/16/32/64. Types are inferred **per file**, so
the same logical field can land on different types in different files. Pass
``--no-bool`` to keep 0/1 columns as integers; see the warning printed when a
column is narrowed to boolean.

Note on narrowing: FlatGeobuf's column types come from OGR, whose type set is
narrower than Arrow's. Unsigned and sub-32-bit integers are stored as int32 and
float32 as float64 (OGR ``Real``), so the on-disk win from ``downcast_numeric``
is smaller here than for the Parquet scripts — an int64 -> int32 halving is
real, a uint8 one is not. It is kept anyway so the three converters agree on
field types, and because bool does survive as OGR's ``OFSTBoolean``.

Usage:
    # Default: convert data/ov.geojson -> data/ov.fgb (indexed)
    python3 convert-geojson-to-flatgeobuf.py

    # Explicit input/output:
    python3 convert-geojson-to-flatgeobuf.py path/to/in.geojson path/to/out.fgb

    # Whole folder -> one .fgb per .geojson, written alongside the inputs:
    python3 convert-geojson-to-flatgeobuf.py path/to/folder
    # ...or to a separate output folder:
    python3 convert-geojson-to-flatgeobuf.py path/to/folder path/to/out_folder

    # Write without the spatial index (smaller file, no bbox range reads):
    python3 convert-geojson-to-flatgeobuf.py path/to/in.geojson --no-index

    # Never infer boolean from 0/1 integer columns:
    python3 convert-geojson-to-flatgeobuf.py path/to/folder --no-bool

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-geojson-to-flatgeobuf.py

Serving the output: an indexed .fgb is only worth it if the host honours HTTP
Range requests (``Accept-Ranges: bytes``) and CORS-exposes ``content-range`` —
without that a client falls back to downloading the whole file.

The app renders these via ``format: "flatgeobuf"`` in ``layers.json`` (the
other formats are ``geoarrow``/``parquet``/``mvt``/``cog``): native MapLibre
layers fed by viewport-bbox Range reads against the spatial index, refreshed on
pan/zoom, and gated by a per-layer ``minzoom`` (default 12). Example entry:
    {
      "id": "bouwjaar_pand_2026",
      "name": "bouwjaar pand",
      "source": "https://data.woonzorglimburg.nl/flatgeobuf/bouwjaar_lb_2026.fgb",
      "format": "flatgeobuf",
      "geometryType": "polygon",
      "minzoom": 12,
      "style": { "opacity": 0.8 }
    }
Like ``mvt``, flatgeobuf layers are not chart/statistics/area-filter eligible
(those consume Arrow tables).
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
    survives into the output as a null rather than a sentinel value.
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
    column is never touched. See the module docstring for why this buys less on
    disk in FlatGeobuf than it does in Parquet: OGR widens the sub-int32 and
    unsigned types back out on write.
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
        # Worth shouting about: unlike an int width change, this one is visible
        # downstream. A bool field reads back as true/false, so String(value)
        # yields "true"/"false" — consumers keyed on "0"/"1" stop matching.
        log(
            f"  WARNING: {', '.join(booled)} -> boolean (only 0/1 in this file). "
            "Consumers grouping on these keys see \"true\"/\"false\", not \"0\"/\"1\". "
            "Re-run with --no-bool to keep them integers."
        )
    return gdf


def normalize_winding(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Orient (multi)polygon rings to RFC 7946 (exterior CCW, holes CW).

    deck.gl's polygon tessellation produces sliver/bridge artefacts for
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
    log=print,
    allow_bool: bool = True,
    spatial_index: bool = True,
) -> None:
    """Convert one GeoJSON file to FlatGeobuf.

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

    # FlatGeobuf holds ONE geometry type per file. A mixed collection would make
    # OGR reject or silently coerce features, so promote to the Multi* form when
    # both the single and multi variants are present.
    if len(geom_types) > 1:
        singles = {"Polygon", "LineString", "Point"}
        base = {t[5:] if t.startswith("Multi") else t for t in geom_types}
        if len(base) == 1 and base.pop() in singles:
            promoted = "Multi" + geom_types[0].removeprefix("Multi")
            log(f"  Mixed {geom_types} -> writing all features as {promoted}")
        else:
            log(f"  Warning: mixed geometry types {geom_types} in one FlatGeobuf file")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    index_note = "packed Hilbert R-tree index" if spatial_index else "no spatial index"
    log(f"Writing  {output_path} ({index_note})")
    # SPATIAL_INDEX is an OGR layer-creation option, forwarded by pyogrio as a
    # keyword. With it on, the R-tree is written between the header and the
    # feature data, which is what allows a reader to range-request only the
    # features intersecting a bbox. GDAL needs a seekable target to write it, so
    # this must be a real file path, not a stream.
    gdf.to_file(
        output_path,
        driver="FlatGeobuf",
        engine="pyogrio",
        SPATIAL_INDEX=spatial_index,
    )

    size = output_path.stat().st_size
    log(f"Wrote {output_path.name} ({size:,} bytes)")


def convert_folder(
    input_dir: Path,
    output_dir: Path,
    allow_bool: bool = True,
    spatial_index: bool = True,
) -> int:
    """Convert every GeoJSON in ``input_dir`` to FlatGeobuf in ``output_dir``.

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
        out = output_dir / (path.stem + ".fgb")
        try:
            convert(
                path,
                out,
                log=tqdm.write,
                allow_bool=allow_bool,
                spatial_index=spatial_index,
            )
        except Exception as err:  # keep going through the batch
            failures += 1
            tqdm.write(f"error converting {path.name}: {err}")

    done = len(files) - failures
    print(f"Done: {done}/{len(files)} converted" + (f", {failures} failed" if failures else ""))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert GeoJSON to FlatGeobuf with a packed Hilbert R-tree index.",
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
            "Output FlatGeobuf path, or output folder in folder mode "
            "(default: input path with .fgb suffix / alongside the inputs)"
        ),
    )
    parser.add_argument(
        "--no-index",
        action="store_true",
        help=(
            "Write without the packed Hilbert R-tree spatial index "
            "(smaller file, but no bbox-filtered HTTP Range reads)"
        ),
    )
    parser.add_argument(
        "--no-bool",
        action="store_true",
        help="Never narrow 0/1 integer columns to boolean",
    )
    args = parser.parse_args(argv[1:])

    allow_bool = not args.no_bool
    spatial_index = not args.no_index

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
            output_dir = input_path  # write .fgb alongside the inputs
        return convert_folder(
            input_path,
            output_dir,
            allow_bool=allow_bool,
            spatial_index=spatial_index,
        )

    # Single-file mode.
    if args.output is not None:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = input_path.with_suffix(".fgb")

    convert(
        input_path,
        output_path,
        allow_bool=allow_bool,
        spatial_index=spatial_index,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
