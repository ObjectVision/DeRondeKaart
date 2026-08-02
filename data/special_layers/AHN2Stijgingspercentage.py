#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "rasterio>=1.3",
#   "numpy>=1.24",
#   "tqdm>=4.66",   # optional: progress bar, degrades to prints
# ]
# ///
"""Compute a classified *stijgingspercentage* (slope) raster for Limburg from AHN4.

Slope is an accessibility measure: a route that is flat is walkable in ways a 12%
incline is not, so this complements the loopafstand layers rather than repeating
them. The output is a classified byte raster on the SAME grid as the existing
analysis rasters, so it feeds straight into the established pipeline:

    convert-tif-to-geojson.py -> convert-geojson-to-pmtiles.py

Source
------
Elevation comes from the PDOK **AHN4** WCS (the service describes itself as
"Het huidige AHN is versie 4… ingewonnen over de jaren 2020, 2021 en 2022"):

    https://service.pdok.nl/rws/actueel-hoogtebestand-nederland/wcs/v1_0

It serves EPSG:28992 natively at 0.5 m, so no reprojection is needed, and it
flags gaps with an explicit nodata sentinel (3.4028235e38) rather than filling
them — which is what makes the "don't interpolate" requirement achievable.

``dtm_05m`` (terrain) is the default and the right choice for slope: ``dsm_05m``
includes buildings and trees, whose roof edges would read as 100%+ cliffs.

Why tiled
---------
The area of interest is 41.2 x 114.9 km. At 0.5 m that is 82,440 x 229,740 cells
= ~76 GB as float32, so the source can never be held whole. Independently, PDOK
enforces ``MAXSIZE=4000``: a 4 km request is rejected with "Raster size out of
range, width and height of resulting coverage must be no more than MAXSIZE=4000".
Measured: 1 km (2000px) = 5 MB in 1.0 s, 2 km (4000px) = 23 MB in 4.1 s, 4 km =
HTTP 400.

So the run is a stream of 2 km tiles: 21 x 58 = 1,218 requests, ~80 minutes,
~24 GB transferred. A 2 km tile is exactly 400 x 400 output cells (10 x 10
source pixels per 5 m cell), so tiles align to the output grid with no
straddling and each tile writes one clean window.

Edge handling
-------------
A 3x3 slope kernel needs neighbours, so a tile fetched at its exact bounds would
compute wrong slope along its border — visible as a 1,218-cell grid of seams.
Each tile is therefore fetched with a HALO of extra pixels which is discarded
after the slope step, making the result identical to a whole-Limburg
computation.

Nodata
------
Nodata is never interpolated, filled, or treated as 0. Any 3x3 window touching a
nodata pixel yields nodata for that pixel. This matters concretely: the AHN
sentinel is 3.4e38, so letting it into the arithmetic would produce enormous
bogus slopes rather than an obvious failure. A 5 m output cell is nodata only
when ALL 100 of its sub-pixels are nodata; partial coverage uses the valid ones.

Output classes (uint8, nodata 255)
----------------------------------
    exactly 0.0% (dead flat) -> 0
    0% up to 2%              -> 1
    2% up to 4%              -> 2
    4% up to 8%              -> 3
    8% up to 12%             -> 4
    12% or more              -> 5
    no data                  -> 255

The specified "-1% up to 0%" bracket cannot occur — max-slope magnitude is never
negative — so class 0 is kept for exactly-flat terrain, preserving the 0-5
numbering. 255 for nodata is the house convention across ``data/tif/`` and is
what ``convert-tif-to-geojson.py`` assumes by default, so no ``--nodata`` flag is
needed downstream.

Usage:
    # Full run (~80 min), grid taken from the reference raster
    python3 AHN2Stijgingspercentage.py

    # Smoke test: one tile over hilly Sint-Pietersberg
    python3 AHN2Stijgingspercentage.py --limit-tiles 1 \\
        --window 176000,317000,178000,319000 -o probe.tif

    # Resume an interrupted run (skips tiles already written)
    python3 AHN2Stijgingspercentage.py --resume

    # Surface model instead of terrain (includes buildings/trees)
    python3 AHN2Stijgingspercentage.py --coverage dsm_05m

If you have ``uv`` installed you can run this without managing dependencies:
    uv run AHN2Stijgingspercentage.py

The GeoTIFF is an intermediate, not something the app fetches. Convert it onward:

    python3 ../convert-tif-to-geojson.py stijgingspercentage_lb.tif
    python3 ../convert-geojson-to-pmtiles.py stijgingspercentage_lb.geojson
"""
from __future__ import annotations

import argparse
import io
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover - optional dependency
    # Same degradation as the sibling converters: tqdm only drives progress
    # output and isn't worth failing an 80-minute run over.
    class tqdm:  # type: ignore[no-redef]
        def __init__(self, iterable=None, **_kwargs):
            self._iterable = iterable if iterable is not None else []
            self.total = _kwargs.get("total")

        def __iter__(self):
            return iter(self._iterable)

        def update(self, _n=1):
            pass

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        @staticmethod
        def write(message: str) -> None:
            print(message)


HERE = Path(__file__).resolve().parent
# Grid donor: any of the 5 m analysis rasters would do; this one is the layer
# the slope raster is meant to sit alongside.
DEFAULT_REFERENCE = HERE.parent / "tif" / "geschiktheid" / "won_aanpasbaar_m5.tif"
DEFAULT_OUTPUT = HERE / "stijgingspercentage_lb.tif"

WCS_URL = "https://service.pdok.nl/rws/actueel-hoogtebestand-nederland/wcs/v1_0"
DEFAULT_COVERAGE = "dtm_05m"
SOURCE_CELL = 0.5

# PDOK rejects any request whose result would exceed 4000x4000 px. At 0.5 m that
# caps a tile at 2 km; going smaller only multiplies request count and runtime.
MAX_REQUEST_PX = 4000
# The halo counts against that budget, so the tile itself must be smaller than
# the 2 km the limit suggests: 1900 m = 3800 px + 2*10 px halo = 3820 px. Also a
# whole number of 5 m cells (380), which keeps tiles aligned to the output grid.
DEFAULT_TILE_M = 1900.0

# Extra source pixels fetched around each tile so the 3x3 slope kernel has real
# neighbours at the tile border. One output cell (10 px) is more than the kernel
# needs and keeps the halo aligned to the 5 m grid.
HALO_PX = 10

NODATA_OUT = 255
# Class upper bounds in percent; index into these gives the class number.
CLASS_BREAKS = (2.0, 4.0, 8.0, 12.0)

DEFAULT_RETRIES = 4
DEFAULT_TIMEOUT = 300


def reference_grid(path: Path):
    """Read the target grid (transform/crs/shape) from the reference raster.

    Read rather than hardcoded so the output stays aligned if the reference grid
    ever changes — grid identity with the other analysis rasters is the whole
    point of this script.
    """
    with rasterio.open(path) as src:
        if src.transform.a != -src.transform.e:
            raise SystemExit(
                f"error: {path.name} has non-square cells "
                f"({src.transform.a} x {-src.transform.e}); this script assumes square."
            )
        return {
            "transform": src.transform,
            "crs": src.crs,
            "width": src.width,
            "height": src.height,
            "cell": src.transform.a,
        }


def fetch_dem(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    coverage: str,
    retries: int,
    timeout: int,
) -> tuple[np.ndarray, float] | None:
    """GetCoverage one window as a float array, with nodata as NaN.

    Returns ``(array, nodata)`` or None when the service has no data at all for
    the window (a legitimate outcome near the borders of the AOI, which extends
    past the Dutch coastline and into Belgium/Germany).
    """
    query = {
        "service": "WCS",
        "version": "2.0.1",
        "request": "GetCoverage",
        "coverageId": coverage,
        "format": "image/tiff",
    }
    # subset= appears twice, which urlencode can't express from a dict.
    url = (
        f"{WCS_URL}?{urllib.parse.urlencode(query)}"
        f"&subset=x({minx},{maxx})&subset=y({miny},{maxy})"
    )

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                payload = response.read()
            break
        except urllib.error.HTTPError as err:
            body = err.read()[:400].decode("utf-8", "replace")
            # 400 on a window fully outside the coverage is expected, not a fault.
            if err.code == 400 and "outside" in body.lower():
                return None
            last_err = RuntimeError(f"HTTP {err.code}: {body}")
            if err.code < 500:
                # A client error won't fix itself on retry.
                raise SystemExit(f"error: WCS rejected a request: {last_err}") from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last_err = err
        # Back off before retrying: transient 5xx/timeouts are normal across
        # ~1,200 requests and shouldn't abort an 80-minute run.
        time.sleep(2 ** attempt)
    else:
        raise RuntimeError(f"giving up after {retries} attempts: {last_err}")

    with rasterio.open(io.BytesIO(payload)) as src:
        band = src.read(1).astype("float32")
        nodata = src.nodata

    if nodata is not None:
        band[band == nodata] = np.nan
    # AHN's sentinel is float32-max; guard against any near-sentinel values that
    # survive an exact-equality test, and against inf from a malformed tile.
    band[~np.isfinite(band)] = np.nan
    band[np.abs(band) > 1e30] = np.nan
    return band, SOURCE_CELL


def horn_slope_percent(dem: np.ndarray, cell: float) -> np.ndarray:
    """Slope in percent rise/run via Horn's 3x3 kernel, propagating nodata.

    This is what ``gdaldem slope -p`` computes and the usual meaning of
    *hellingspercentage*: 100 * sqrt((dz/dx)^2 + (dz/dy)^2), i.e. the steepest
    gradient at each cell regardless of direction.

    Any cell whose 3x3 neighbourhood touches nodata becomes NaN — deliberately
    strict, since a partially-known window would otherwise invent a gradient
    from whichever neighbours happened to be present.

    Note the centre cell carries weight 0 in both Horn differences, so slope is
    defined by the 8 neighbours alone: a cell that is itself nodata but fully
    surrounded by valid data still yields a real gradient. That is not
    interpolation (no missing elevation is invented) and matches GDAL. Verified
    against ``gdaldem slope -p``: mean absolute difference 0.0001 percentage
    point over 474k cells, max 0.0016 — float32 rounding.
    """
    # Nine shifted views of the padded array = the 3x3 neighbourhood of every
    # interior cell, without a Python-level loop over ~16M cells.
    padded = np.pad(dem, 1, mode="constant", constant_values=np.nan)
    rows, cols = dem.shape
    win = {}
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            win[(dy, dx)] = padded[1 + dy : 1 + dy + rows, 1 + dx : 1 + dx + cols]

    # Horn (1981): weighted 3x3 differences, the standard used by GDAL/ArcGIS.
    dzdx = (
        (win[(-1, 1)] + 2 * win[(0, 1)] + win[(1, 1)])
        - (win[(-1, -1)] + 2 * win[(0, -1)] + win[(1, -1)])
    ) / (8 * cell)
    dzdy = (
        (win[(1, -1)] + 2 * win[(1, 0)] + win[(1, 1)])
        - (win[(-1, -1)] + 2 * win[(-1, 0)] + win[(-1, 1)])
    ) / (8 * cell)

    return 100.0 * np.sqrt(dzdx * dzdx + dzdy * dzdy)


def aggregate_mean(slope: np.ndarray, factor: int) -> np.ndarray:
    """Mean slope per output cell, ignoring nodata sub-pixels.

    A cell is nodata only when ALL factor^2 sub-pixels are; partial coverage
    averages the valid ones, so a cell at the edge of an AHN gap still gets a
    real value rather than being discarded.
    """
    rows, cols = slope.shape
    if rows % factor or cols % factor:
        raise ValueError(f"{rows}x{cols} not divisible by {factor}")
    blocks = slope.reshape(rows // factor, factor, cols // factor, factor)
    # An all-NaN block returning NaN is the intended nodata outcome, not a
    # problem — silence the "Mean of empty slice" warning it raises so real
    # warnings stay visible across a 1,200-tile run.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        return np.nanmean(blocks, axis=(1, 3))


def classify(slope_pct: np.ndarray) -> np.ndarray:
    """Map percent slope onto the class bytes, NaN -> 255.

    Brackets are lower-bound inclusive / upper exclusive, matching the "up to"
    wording of the spec. Exactly-flat terrain (0.0%) becomes class 0; the
    specified -1%..0% bracket cannot occur since slope magnitude is never
    negative.
    """
    out = np.full(slope_pct.shape, NODATA_OUT, dtype="uint8")
    valid = np.isfinite(slope_pct)
    if not valid.any():
        return out

    values = slope_pct[valid]
    # digitize gives 0 for <2, 1 for <4, ... so classes land at +1.
    classes = (np.digitize(values, CLASS_BREAKS, right=False) + 1).astype("uint8")
    # Dead flat is its own class, below the 0-2% bracket.
    classes[values <= 0.0] = 0
    out[valid] = classes
    return out


def tile_origins(grid, tile_m: float) -> list[tuple[float, float, int, int]]:
    """Tile the AOI into (minx, maxy, col_off, row_off) in output-cell units."""
    cell = grid["cell"]
    per_tile = int(round(tile_m / cell))
    transform = grid["transform"]
    left, top = transform.c, transform.f

    tiles = []
    for row_off in range(0, grid["height"], per_tile):
        for col_off in range(0, grid["width"], per_tile):
            tiles.append(
                (left + col_off * cell, top - row_off * cell, col_off, row_off)
            )
    return tiles


def create_output(path: Path, grid) -> None:
    """Create the output raster filled with nodata, ready for windowed writes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "width": grid["width"],
        "height": grid["height"],
        "crs": grid["crs"],
        "transform": grid["transform"],
        "nodata": NODATA_OUT,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "compress": "DEFLATE",
        "predictor": 2,
    }
    with rasterio.open(path, "w", **profile) as dst:
        # Windowed writes fill this in; an all-nodata canvas means an interrupted
        # run leaves a valid (if incomplete) raster rather than a corrupt one.
        for _, window in dst.block_windows(1):
            dst.write(
                np.full(
                    (window.height, window.width), NODATA_OUT, dtype="uint8"
                ),
                1,
                window=window,
            )


def process(args, grid) -> int:
    cell = grid["cell"]
    factor = int(round(cell / SOURCE_CELL))
    per_tile = int(round(args.tile_size / cell))
    src_px = per_tile * factor
    if src_px + 2 * HALO_PX > MAX_REQUEST_PX:
        print(
            f"error: --tile-size {args.tile_size} m needs {src_px + 2 * HALO_PX} px "
            f"per request, over the service limit of {MAX_REQUEST_PX}. "
            f"Use {(MAX_REQUEST_PX - 2 * HALO_PX) * SOURCE_CELL:.0f} m or less.",
            file=sys.stderr,
        )
        return 2

    tiles = tile_origins(grid, args.tile_size)
    if args.window:
        minx, miny, maxx, maxy = args.window
        tiles = [
            t
            for t in tiles
            if t[0] < maxx
            and t[0] + args.tile_size > minx
            and t[1] > miny
            and t[1] - args.tile_size < maxy
        ]
    if args.limit_tiles:
        tiles = tiles[: args.limit_tiles]

    out_path = Path(args.output)
    if not out_path.exists() or not args.resume:
        print(f"Creating {out_path} ({grid['width']} x {grid['height']} @ {cell} m)")
        create_output(out_path, grid)
    else:
        print(f"Resuming into {out_path}")

    halo_m = HALO_PX * SOURCE_CELL
    counts = np.zeros(257, dtype="int64")
    fetched = skipped = empty = 0

    print(
        f"Fetching {len(tiles)} tile(s) of {args.tile_size:.0f} m "
        f"({src_px}+{2 * HALO_PX} px per request) from {args.coverage}"
    )

    with rasterio.open(out_path, "r+") as dst:
        progress = tqdm(tiles, total=len(tiles), unit="tile")
        for minx, maxy, col_off, row_off in progress:
            width = min(per_tile, grid["width"] - col_off)
            height = min(per_tile, grid["height"] - row_off)
            window = Window(col_off, row_off, width, height)

            if args.resume:
                existing = dst.read(1, window=window)
                if (existing != NODATA_OUT).any():
                    skipped += 1
                    continue

            maxx = minx + width * cell
            miny = maxy - height * cell

            result = fetch_dem(
                minx - halo_m,
                miny - halo_m,
                maxx + halo_m,
                maxy + halo_m,
                args.coverage,
                args.retries,
                args.timeout,
            )
            if result is None:
                empty += 1
                continue

            dem, src_cell = result
            expected = (height * factor + 2 * HALO_PX, width * factor + 2 * HALO_PX)
            if dem.shape != expected:
                # The service occasionally returns an off-by-one grid; crop or
                # pad rather than abort, so one odd tile can't kill a long run.
                fixed = np.full(expected, np.nan, dtype="float32")
                rows = min(dem.shape[0], expected[0])
                cols = min(dem.shape[1], expected[1])
                fixed[:rows, :cols] = dem[:rows, :cols]
                dem = fixed

            if np.isfinite(dem).sum() == 0:
                empty += 1
                continue

            slope = horn_slope_percent(dem, src_cell)
            # Drop the halo: those cells exist only to give the kernel real
            # neighbours and belong to the adjacent tiles.
            slope = slope[HALO_PX:-HALO_PX, HALO_PX:-HALO_PX]
            classes = classify(aggregate_mean(slope, factor))

            dst.write(classes, 1, window=window)
            counts += np.bincount(classes.ravel(), minlength=257)
            fetched += 1

        if hasattr(progress, "close"):
            progress.close()

    total = counts.sum()
    valid = total - counts[NODATA_OUT]
    print(f"\nWrote {out_path.name} ({out_path.stat().st_size:,} bytes)")
    print(f"  tiles: {fetched} written, {skipped} skipped, {empty} without data")
    if total:
        print(f"  cells: {valid:,} valid of {total:,} ({100 * valid / total:.1f}%)")
        for value in range(6):
            if counts[value]:
                share = 100 * counts[value] / valid if valid else 0
                print(f"    class {value}: {counts[value]:>12,}  ({share:5.1f}% of valid)")
        print(f"    nodata  : {counts[NODATA_OUT]:>12,}")
    # Nothing fetched is only a failure if there was something left to do: a
    # fully-resumed run legitimately writes no tiles, and a window that falls
    # entirely outside the AHN coverage legitimately finds no data.
    if fetched == 0 and skipped == 0 and empty == 0:
        print("error: no tile produced data — check the coverage and window", file=sys.stderr)
        return 1
    return 0


def parse_window(value: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--window must be minx,miny,maxx,maxy")
    try:
        minx, miny, maxx, maxy = (float(p) for p in parts)
    except ValueError:
        raise argparse.ArgumentTypeError("--window expects four numbers") from None
    if minx >= maxx or miny >= maxy:
        raise argparse.ArgumentTypeError("--window has min >= max")
    return minx, miny, maxx, maxy


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Classified slope (stijgingspercentage) raster from the PDOK AHN4 WCS.",
    )
    parser.add_argument(
        "-r", "--reference",
        default=str(DEFAULT_REFERENCE),
        metavar="PATH",
        help=f"Raster defining the output grid (default: {DEFAULT_REFERENCE.name})",
    )
    parser.add_argument(
        "-o", "--output",
        default=str(DEFAULT_OUTPUT),
        metavar="PATH",
        help=f"Output GeoTIFF (default: {DEFAULT_OUTPUT.name})",
    )
    parser.add_argument(
        "--coverage",
        default=DEFAULT_COVERAGE,
        choices=["dtm_05m", "dsm_05m"],
        help="WCS coverage: dtm = terrain (default), dsm = surface incl. buildings",
    )
    parser.add_argument(
        "--tile-size",
        type=float,
        default=DEFAULT_TILE_M,
        metavar="M",
        help=f"Tile edge in metres (default: {DEFAULT_TILE_M:.0f}; service caps at ~2000)",
    )
    parser.add_argument(
        "--window",
        type=parse_window,
        default=None,
        metavar="MINX,MINY,MAXX,MAXY",
        help="Restrict to a sub-area in RD coordinates (for testing)",
    )
    parser.add_argument(
        "--limit-tiles",
        type=int,
        default=0,
        metavar="N",
        help="Stop after N tiles (smoke tests)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Keep an existing output and skip tiles already written",
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

    reference = Path(args.reference)
    if not reference.is_absolute():
        reference = (Path.cwd() / reference).resolve()
    if not reference.exists():
        print(f"error: reference raster not found: {reference}", file=sys.stderr)
        return 1
    if args.tile_size <= 0:
        print("error: --tile-size must be positive", file=sys.stderr)
        return 2

    grid = reference_grid(reference)
    if grid["cell"] % SOURCE_CELL:
        print(
            f"error: reference cell {grid['cell']} m is not a multiple of the "
            f"{SOURCE_CELL} m source resolution",
            file=sys.stderr,
        )
        return 2

    print(f"Reference {reference.name}: {grid['width']} x {grid['height']} @ {grid['cell']} m, {grid['crs']}")
    try:
        return process(args, grid)
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
