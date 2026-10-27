#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "pyogrio>=0.9",
#   "shapely>=2.0",
#   "pandas>=2.0",
#   "rasterio>=1.3",
#   "numpy>=1.24",
#   "tqdm>=4.66",   # optional: progress bar, degrades to prints
# ]
# ///
"""Compute the *stijgingspercentage* ALONG each OSM road from AHN4, per province.

``AHN2Stijgingspercentage.py`` answers "how steep is the terrain here". This
script answers the accessibility question that sits next to it: how steep is the
road a walker, cyclist or wheelchair user actually follows. A street running
along a hillside sits on steep terrain but can itself be level; the terrain
raster would colour it class 5, this layer colours it by its own gradient.

Output is a line GeoJSON (EPSG:4326) of short road pieces, each carrying its
gradient and the same 0-5 classes as the raster layer, so legend and colours can
be shared. It feeds the established pipeline:

    convert-geojson-to-pmtiles.py

Sources
-------
Roads: the Geofabrik shapefile extracts, one folder per province:

    D:/SourceData/OSM/20260101/<provincie>/gis_osm_roads_free_1.shp

The ``roads.fss`` next to those folders is a GeoDMS store and not readable from
Python; the per-province extracts hold the same roads and map one-to-one onto
``--provinces``. Geofabrik keeps whole ways that cross a province border in
BOTH extracts, so a multi-province run deduplicates on ``osm_id``.

Elevation: the PDOK AHN4 ``dtm_05m`` WCS, fetched and smoothed exactly as the
sibling script does (``fetch_dem``, ``boxblur`` are imported from it).

Method
------
1. Bridges and tunnels are dropped. The DTM is the ground surface: a bridge deck
   or tunnel tube is not in it, so a viaduct would "descend" into the valley it
   spans and report a gradient no one ever climbs.
2. Every way is cut into equal pieces of about ``--segment`` metres (25 m). A
   whole way is one piece when it is shorter than 1.5 x that.
3. Each piece is sampled every ``--sample`` metres (2.5 m) on the smoothed DTM.
4. The gradient is the least-squares slope of elevation over distance across
   those samples, in percent. A fit rather than end-minus-start, so one noisy
   sample at a kerb or ditch edge cannot set the result on its own.

Nodata is never filled: a sample on an AHN gap is NaN. A piece is nodata (class
255, ``stijging_pct`` null) when it is shorter than ``--min-length``, or when
fewer than half its samples, or fewer than two, are valid. Ways outside the
Netherlands (Geofabrik extracts reach into Belgium/Germany) land here too.

Fetching and cache
------------------
Sample points are binned into 1860 m tiles on a fixed RD grid and only tiles
that hold points are requested — the same tile size and halo budget as the
sibling script, which keeps every request under PDOK's MAXSIZE=4000. Each raw
tile is cached under ``--cache-dir`` as an int16 centimetre GeoTIFF (AHN
heights fit int16 cm with room to spare: NAP -7 m to +323 m), so a rerun, a
different ``--segment``, or a neighbouring province reuses what is already on
disk. Tiles the service has no data for are remembered with a ``.empty`` marker.

Output fields
-------------
    osm_id        OSM way id
    fclass        Geofabrik road class (residential, footway, ...) for filtering
    name          street name, may be empty
    lengte_m      piece length
    stijging_pct  |gradient| in percent, 1 decimal; null on nodata
    dz_m          height change over the piece, positive = rising in the OSM
                  drawing direction (only meaningful with ``oneway``)
    klasse        0 flat, 1 <2%, 2 <4%, 3 <8%, 4 <12%, 5 >=12%, 255 nodata

Field names are snake_case because convert-geojson-to-pmtiles.py lowercases them.

Usage:
    # Limburg (default)
    python3 AHN_OSM_2StijgingspercentageWeg.py

    # Several provinces in one layer
    python3 AHN_OSM_2StijgingspercentageWeg.py --provinces limburg noordbrabant

    # Every province folder found under --osm-dir
    python3 AHN_OSM_2StijgingspercentageWeg.py --provinces all

    # Smoke test: Sint-Pietersberg
    python3 AHN_OSM_2StijgingspercentageWeg.py \\
        --window 176000,317000,178000,319000 -o probe.geojson

If you have ``uv`` installed you can run this without managing dependencies:
    uv run AHN_OSM_2StijgingspercentageWeg.py

Then tile it:
    python3 ../convert-geojson-to-pmtiles.py stijgingspercentage_weg_limburg.geojson
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import rasterio
import shapely
from shapely.ops import substring

HERE = Path(__file__).resolve().parent
# The DEM fetch, smoothing and classes are the sibling script's, imported rather
# than copied so the road layer and the terrain raster can never drift apart.
sys.path.insert(0, str(HERE))
from AHN2Stijgingspercentage import (  # noqa: E402
    DEFAULT_COVERAGE,
    DEFAULT_RETRIES,
    DEFAULT_SMOOTH_PX,
    DEFAULT_TILE_M,
    DEFAULT_TIMEOUT,
    MAX_REQUEST_PX,
    NODATA_OUT,
    SOURCE_CELL,
    boxblur,
    classify,
    fetch_dem,
    halo_for,
    parse_window,
    tqdm,
)

DEFAULT_OSM_DIR = Path(r"D:\SourceData\OSM\20260101")
ROADS_SHP = "gis_osm_roads_free_1.shp"
DEFAULT_PROVINCES = ["limburg"]
DEFAULT_CACHE = HERE / "work" / "ahn_cache"

RD = "EPSG:28992"
WGS84 = "EPSG:4326"

DEFAULT_SEGMENT_M = 25.0
DEFAULT_SAMPLE_M = 2.5
# Below this a piece's gradient is dominated by DTM noise: 10 cm of error over
# 5 m already reads as 2%.
DEFAULT_MIN_LENGTH_M = 10.0
# Share of a piece's samples that must hit AHN data for its gradient to count.
MIN_VALID_SHARE = 0.5

# Cache encoding: int16 centimetres, with the int16 minimum as nodata.
CACHE_NODATA = -32768


def available_provinces(osm_dir: Path) -> list[str]:
    return sorted(
        p.name for p in osm_dir.iterdir() if p.is_dir() and (p / ROADS_SHP).exists()
    )


def load_roads(osm_dir: Path, provinces: list[str], window) -> gpd.GeoDataFrame:
    """Read, merge and clean the roads of all requested provinces, in RD."""
    frames = []
    for province in provinces:
        path = osm_dir / province / ROADS_SHP
        frame = pyogrio.read_dataframe(
            path, columns=["osm_id", "fclass", "name", "bridge", "tunnel"]
        )
        print(f"  {province}: {len(frame):,} ways")
        frames.append(frame)
    roads = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)

    before = len(roads)
    # Border-crossing ways are in both neighbouring extracts.
    roads = roads.drop_duplicates(subset="osm_id")
    duplicates = before - len(roads)

    structure = (roads["bridge"] == "T") | (roads["tunnel"] == "T")
    roads = roads[~structure & roads.geometry.notna() & ~roads.geometry.is_empty]
    print(
        f"  {len(roads):,} ways kept ({duplicates:,} duplicates across provinces, "
        f"{int(structure.sum()):,} bridges/tunnels dropped)"
    )

    roads = roads.to_crs(RD).explode(index_parts=False)
    if window:
        roads = roads[roads.intersects(shapely.box(*window))]
        print(f"  {len(roads):,} ways intersect --window")
    return roads.drop(columns=["bridge", "tunnel"]).reset_index(drop=True)


def split_pieces(roads: gpd.GeoDataFrame, segment: float) -> pd.DataFrame:
    """One row per piece: source way index, start distance, length."""
    lengths = roads.geometry.length.to_numpy()
    counts = np.maximum(1, np.round(lengths / segment)).astype("int64")
    way = np.repeat(np.arange(len(roads)), counts)
    # k-th piece of its way: position minus the way's first piece position.
    first = np.repeat(np.cumsum(counts) - counts, counts)
    k = np.arange(counts.sum()) - first
    piece_len = lengths[way] / counts[way]
    return pd.DataFrame({"way": way, "start": k * piece_len, "length": piece_len})


def sample_points(roads: gpd.GeoDataFrame, pieces: pd.DataFrame, spacing: float):
    """Evenly spaced points along every piece, both ends included.

    Returns (piece index, distance along piece, x, y) as flat arrays, so the
    millions of points are never Python objects.
    """
    intervals = np.maximum(1, np.ceil(pieces["length"].to_numpy() / spacing)).astype(
        "int64"
    )
    per_piece = intervals + 1
    piece = np.repeat(np.arange(len(pieces)), per_piece)
    first = np.repeat(np.cumsum(per_piece) - per_piece, per_piece)
    j = np.arange(per_piece.sum()) - first
    along = j * (pieces["length"].to_numpy()[piece] / intervals[piece])

    lines = roads.geometry.to_numpy()[pieces["way"].to_numpy()[piece]]
    points = shapely.line_interpolate_point(
        lines, pieces["start"].to_numpy()[piece] + along
    )
    xy = shapely.get_coordinates(points)
    return piece, along, xy[:, 0], xy[:, 1]


def cache_paths(cache_dir: Path, coverage: str, halo_px: int, ix: int, iy: int):
    stem = f"{coverage}_h{halo_px}_{ix}_{iy}"
    return cache_dir / f"{stem}.tif", cache_dir / f"{stem}.empty"


def tile_dem(ix: int, iy: int, tile_m: float, halo_px: int, args) -> tuple[np.ndarray | None, str]:
    """The raw DEM of one tile plus halo, as float32 with NaN nodata.

    Returns (array or None, "cached" | "fetched" | "empty").
    """
    cache_dir = Path(args.cache_dir)
    tif, empty = cache_paths(cache_dir, args.coverage, halo_px, ix, iy)
    if empty.exists():
        return None, "empty"

    halo_m = halo_px * SOURCE_CELL
    minx, miny = ix * tile_m - halo_m, iy * tile_m - halo_m
    maxx, maxy = (ix + 1) * tile_m + halo_m, (iy + 1) * tile_m + halo_m

    if tif.exists():
        with rasterio.open(tif) as src:
            cm = src.read(1)
        dem = cm.astype("float32") / 100
        dem[cm == CACHE_NODATA] = np.nan
        return dem, "cached"

    cache_dir.mkdir(parents=True, exist_ok=True)
    result = fetch_dem(minx, miny, maxx, maxy, args.coverage, args.retries, args.timeout)
    if result is None or not np.isfinite(result[0]).any():
        empty.touch()
        return None, "empty"

    dem = result[0]
    side = int(round(tile_m / SOURCE_CELL)) + 2 * halo_px
    if dem.shape != (side, side):
        # Same off-by-one tolerance as the sibling script.
        fixed = np.full((side, side), np.nan, dtype="float32")
        rows, cols = min(dem.shape[0], side), min(dem.shape[1], side)
        fixed[:rows, :cols] = dem[:rows, :cols]
        dem = fixed

    cm = np.round(dem * 100)
    cm[~np.isfinite(cm) | (np.abs(cm) > 32767)] = CACHE_NODATA
    profile = {
        "driver": "GTiff",
        "dtype": "int16",
        "count": 1,
        "width": side,
        "height": side,
        "crs": RD,
        "transform": rasterio.transform.from_origin(minx, maxy, SOURCE_CELL, SOURCE_CELL),
        "nodata": CACHE_NODATA,
        "compress": "DEFLATE",
        "predictor": 2,
        "tiled": True,
    }
    # Write-then-rename: an interrupted run must not leave a truncated tile
    # that the next run would trust.
    partial = tif.with_suffix(".partial.tif")
    with rasterio.open(partial, "w", **profile) as dst:
        dst.write(cm.astype("int16"), 1)
    os.replace(partial, tif)
    return dem, "fetched"


def sample_elevation(x: np.ndarray, y: np.ndarray, args) -> np.ndarray:
    """Smoothed DTM height at every point, NaN where AHN has no data."""
    tile_m = args.tile_size
    halo_px = halo_for(args.smooth)
    z = np.full(x.shape, np.nan, dtype="float64")

    ix = np.floor(x / tile_m).astype("int64")
    iy = np.floor(y / tile_m).astype("int64")
    # Group points by tile without a per-point loop: sort once, then slice.
    order = np.lexsort((ix, iy))
    keys = np.stack([ix[order], iy[order]], axis=1)
    starts = np.flatnonzero(np.any(np.diff(keys, axis=0) != 0, axis=1)) + 1
    bounds = np.concatenate([[0], starts, [len(order)]])

    status = {"cached": 0, "fetched": 0, "empty": 0}
    halo_m = halo_px * SOURCE_CELL
    print(f"Sampling {len(x):,} points in {len(bounds) - 1:,} tile(s) of {tile_m:.0f} m")
    for a, b in tqdm(list(zip(bounds[:-1], bounds[1:])), unit="tile"):
        tx, ty = int(keys[a, 0]), int(keys[a, 1])
        dem, how = tile_dem(tx, ty, tile_m, halo_px, args)
        status[how] += 1
        if dem is None:
            continue
        smooth = boxblur(dem, args.smooth)

        idx = order[a:b]
        left = tx * tile_m - halo_m
        top = (ty + 1) * tile_m + halo_m
        cols = np.floor((x[idx] - left) / SOURCE_CELL).astype("int64")
        rows = np.floor((top - y[idx]) / SOURCE_CELL).astype("int64")
        np.clip(cols, 0, smooth.shape[1] - 1, out=cols)
        np.clip(rows, 0, smooth.shape[0] - 1, out=rows)
        z[idx] = smooth[rows, cols]

    print(
        f"  tiles: {status['fetched']} fetched, {status['cached']} from cache, "
        f"{status['empty']} without data"
    )
    return z


def gradients(piece, along, z, pieces: pd.DataFrame, min_length: float):
    """Least-squares gradient (dz/ds) per piece over its valid samples.

    Vectorised as per-piece sums via bincount; returns NaN where the piece
    fails the length or coverage requirements.
    """
    n_pieces = len(pieces)
    valid = np.isfinite(z)
    p, s, h = piece[valid], along[valid], z[valid]

    n = np.bincount(p, minlength=n_pieces).astype("float64")
    total = np.bincount(piece, minlength=n_pieces).astype("float64")
    sum_s = np.bincount(p, s, n_pieces)
    sum_z = np.bincount(p, h, n_pieces)
    sum_ss = np.bincount(p, s * s, n_pieces)
    sum_sz = np.bincount(p, s * h, n_pieces)

    with np.errstate(invalid="ignore", divide="ignore"):
        slope = (n * sum_sz - sum_s * sum_z) / (n * sum_ss - sum_s * sum_s)

    ok = (
        (pieces["length"].to_numpy() >= min_length)
        & (n >= 2)
        & (n >= MIN_VALID_SHARE * total)
        & np.isfinite(slope)
    )
    return np.where(ok, slope, np.nan)


def write_output(roads, pieces, slope, path: Path) -> np.ndarray:
    geometry = [
        substring(roads.geometry.iat[w], s, s + l)
        for w, s, l in zip(pieces["way"], pieces["start"], pieces["length"])
    ]
    pct = np.abs(slope) * 100
    klasse = classify(pct)
    nodata = ~np.isfinite(slope)

    out = gpd.GeoDataFrame(
        {
            "osm_id": roads["osm_id"].to_numpy()[pieces["way"]],
            "fclass": roads["fclass"].to_numpy()[pieces["way"]],
            "name": roads["name"].to_numpy()[pieces["way"]],
            "lengte_m": np.round(pieces["length"].to_numpy(), 1),
            # Nullable floats so nodata is written as JSON null, not NaN.
            "stijging_pct": pd.array(np.round(pct, 1), dtype="Float64"),
            "dz_m": pd.array(np.round(slope * pieces["length"].to_numpy(), 2), dtype="Float64"),
            "klasse": klasse,
        },
        geometry=geometry,
        crs=RD,
    )
    out.loc[nodata, ["stijging_pct", "dz_m"]] = pd.NA

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    pyogrio.write_dataframe(
        out.to_crs(WGS84),
        path,
        driver="GeoJSON",
        layer_options={"COORDINATE_PRECISION": 7, "RFC7946": "YES"},
    )
    return klasse


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Along-road gradient (stijgingspercentage) of OSM roads from the PDOK AHN4 WCS.",
    )
    parser.add_argument(
        "--osm-dir",
        default=str(DEFAULT_OSM_DIR),
        metavar="PATH",
        help=f"Folder with one Geofabrik extract per province (default: {DEFAULT_OSM_DIR})",
    )
    parser.add_argument(
        "--provinces",
        nargs="+",
        default=DEFAULT_PROVINCES,
        metavar="NAME",
        help="Province folder name(s), or 'all' (default: limburg)",
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        metavar="PATH",
        help="Output GeoJSON (default: stijgingspercentage_weg_<provinces>.geojson)",
    )
    parser.add_argument(
        "--coverage",
        default=DEFAULT_COVERAGE,
        choices=["dtm_05m", "dsm_05m"],
        help="WCS coverage (default: dtm_05m; dsm includes buildings and trees)",
    )
    parser.add_argument(
        "--segment",
        type=float,
        default=DEFAULT_SEGMENT_M,
        metavar="M",
        help=f"Target piece length in metres (default: {DEFAULT_SEGMENT_M:.0f})",
    )
    parser.add_argument(
        "--sample",
        type=float,
        default=DEFAULT_SAMPLE_M,
        metavar="M",
        help=f"Sample spacing along a piece in metres (default: {DEFAULT_SAMPLE_M})",
    )
    parser.add_argument(
        "--min-length",
        type=float,
        default=DEFAULT_MIN_LENGTH_M,
        metavar="M",
        help=f"Pieces shorter than this get nodata (default: {DEFAULT_MIN_LENGTH_M:.0f})",
    )
    parser.add_argument(
        "--smooth",
        type=int,
        default=DEFAULT_SMOOTH_PX,
        metavar="PX",
        help=f"Box-mean kernel on the DEM in 0.5 m pixels, odd (default: {DEFAULT_SMOOTH_PX}; 0/1 disables)",
    )
    parser.add_argument(
        "--tile-size",
        type=float,
        default=DEFAULT_TILE_M,
        metavar="M",
        help=f"WCS tile edge in metres (default: {DEFAULT_TILE_M:.0f})",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(DEFAULT_CACHE),
        metavar="PATH",
        help="Where fetched AHN tiles are kept between runs (default: work/ahn_cache)",
    )
    parser.add_argument(
        "--window",
        type=parse_window,
        default=None,
        metavar="MINX,MINY,MAXX,MAXY",
        help="Only ways intersecting this RD box (for testing)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=DEFAULT_RETRIES,
        metavar="N",
        help=f"Attempts per tile before giving up (default: {DEFAULT_RETRIES})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        metavar="SECONDS",
        help=f"Per-request timeout (default: {DEFAULT_TIMEOUT})",
    )
    args = parser.parse_args(argv[1:])

    osm_dir = Path(args.osm_dir)
    if not osm_dir.is_dir():
        print(f"error: OSM folder not found: {osm_dir}", file=sys.stderr)
        return 1
    available = available_provinces(osm_dir)
    if args.provinces == ["all"]:
        provinces = available
    else:
        provinces = list(dict.fromkeys(p.lower() for p in args.provinces))
        unknown = [p for p in provinces if p not in available]
        if unknown:
            print(
                f"error: no {ROADS_SHP} for {', '.join(unknown)} in {osm_dir}; "
                f"available: {', '.join(available)}",
                file=sys.stderr,
            )
            return 2
    if not provinces:
        print(f"error: no province folders with {ROADS_SHP} in {osm_dir}", file=sys.stderr)
        return 1

    if args.segment <= 0 or args.sample <= 0 or args.min_length < 0:
        print("error: --segment and --sample must be positive, --min-length >= 0", file=sys.stderr)
        return 2
    if args.smooth > 1 and args.smooth % 2 == 0:
        # Same reason as the sibling: an even kernel shifts the terrain sideways.
        print(f"error: --smooth must be odd, got {args.smooth}", file=sys.stderr)
        return 2
    tile_px = args.tile_size / SOURCE_CELL
    halo_px = halo_for(args.smooth)
    if tile_px != int(tile_px) or tile_px + 2 * halo_px > MAX_REQUEST_PX:
        usable = (MAX_REQUEST_PX - 2 * halo_px) * SOURCE_CELL
        print(
            f"error: --tile-size must be a multiple of {SOURCE_CELL} m and at most "
            f"{usable:.0f} m with --smooth {args.smooth}",
            file=sys.stderr,
        )
        return 2

    suffix = "alle" if args.provinces == ["all"] else "_".join(provinces)
    output = Path(args.output) if args.output else HERE / f"stijgingspercentage_weg_{suffix}.geojson"

    print(f"Reading roads from {osm_dir}")
    roads = load_roads(osm_dir, provinces, args.window)
    if roads.empty:
        print("error: no roads left to process", file=sys.stderr)
        return 1

    pieces = split_pieces(roads, args.segment)
    piece, along, x, y = sample_points(roads, pieces, args.sample)
    print(f"  {len(pieces):,} pieces of ~{args.segment:.0f} m")

    try:
        z = sample_elevation(x, y, args)
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    slope = gradients(piece, along, z, pieces, args.min_length)
    print(f"Writing {output}")
    klasse = write_output(roads, pieces, slope, output)

    counts = np.bincount(klasse, minlength=256)
    valid = len(klasse) - counts[NODATA_OUT]
    print(f"\nWrote {output.name} ({output.stat().st_size:,} bytes)")
    print(f"  pieces: {valid:,} valid of {len(klasse):,}")
    for value in range(6):
        if counts[value]:
            share = 100 * counts[value] / valid if valid else 0
            print(f"    class {value}: {counts[value]:>10,}  ({share:5.1f}% of valid)")
    print(f"    nodata : {counts[NODATA_OUT]:>10,}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
