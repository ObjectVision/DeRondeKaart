#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.24",
#   "rasterio>=1.3",
#   "rio-cogeo>=5",
# ]
# ///
"""Convert a classified GeoTIFF to a COG on one **shared, uniform grid**.

This is the alignment-guaranteeing sibling of ``convert-tif-to-cog.py``. That
script is the general-purpose display converter and is still the right tool for
a single raster you only want to draw. Use *this* one when several rasters must
be **combined cell-by-cell** — overlay scoring, "where does class X of layer A
meet class Y of layer B" — because that is only sound when every input lands on
exactly the same grid.

Why a second script
-------------------
``convert-tif-to-cog.py`` calls ``cog_translate(..., web_optimized=True)`` and
leaves ``zoom_level`` unset. rio-cogeo's ``zoom_level_strategy="auto"`` then
picks a zoom level **per input**, from that input's own resolution. Rasters of
differing native resolution therefore land on *different* grids, and a
one-pixel origin offset silently produces a wrong overlay — wrong in a way that
still renders perfectly. Pinning ``--zoom`` is the whole point of this script.

Grid
----
Output is **EPSG:3857** pinned to the WebMercatorQuad tiling grid at ``--zoom``
(default 14). That choice is forced by the renderer, not preferred:
``@geomatico/maplibre-cog-protocol`` 0.9.1 hard-rejects anything else with
"COG projection EPSG:<C> ... is not supported. Reproject to EPSG:3857".

The name says "10m" for the nominal target, but no EPSG:3857 pixel is 10 m of
ground, because Web Mercator's scale factor is ``1/cos(lat)``:

    zoom 14  ->  9.5546 units/px  ->  ~6.00 m ground at 51.09 N (Limburg)

A true 10 m grid exists only in EPSG:28992 (RD New), which the protocol
rejects. What actually delivers the guarantee is a **shared tiling grid**, not a
round metre figure — every output at the same ``--zoom`` shares CRS, origin and
resolution, so cells correspond one-to-one.

Resampling defaults to ``nearest`` because these are **class** rasters: averaging
two neighbouring classes invents a third that means nothing. The script warns
loudly if an interpolating method meets an integer dtype.

Verify alignment with ``--expect-grid``, which asserts the output shares CRS,
transform and shape with a reference COG. Run it pairwise across a set and the
whole set is proven to be co-registered; that check belongs here in the pipeline
rather than in the browser, where a misalignment is invisible.

Usage:
    # Default: -> tif/afstanden/huisarts_lb_m5.cog.tif at zoom 14
    python3 convert-tif-to-cog-10m.py tif/afstanden/huisarts_lb_m5.tif

    # Assert a second raster lands on the same grid as the first
    python3 convert-tif-to-cog-10m.py tif/geschiktheid/won_aanpasbaar_m5.tif \\
        --expect-grid tif/afstanden/huisarts_lb_m5.cog.tif

    # Finer grid (zoom 15 ~ 3.00 m ground at this latitude)
    python3 convert-tif-to-cog-10m.py input.tif --zoom 15
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
import rasterio.warp
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

# 255 is the class-raster nodata convention in this folder; the source files
# leave the tag unset. Matches convert-tif-to-geojson.py.
DEFAULT_NODATA = 255

# WebMercatorQuad z14. Chosen as the default because it is the level whose
# ground resolution (~6 m at Limburg's latitude) is closest to the 5 m sources
# without upsampling them into a false precision.
DEFAULT_ZOOM = 14

# Class rasters only: averaging classes invents values that were never measured.
DEFAULT_RESAMPLING = "nearest"

# Methods that blend neighbouring cells, and so must not silently be used on
# integer class data.
INTERPOLATING = {"average", "bilinear", "cubic"}

# Web Mercator spans 2 * pi * a metres across 256 px at zoom 0.
EARTH_CIRCUMFERENCE = 2 * math.pi * 6378137.0


def ground_resolution(zoom: int, latitude: float) -> tuple[float, float]:
    """Return (units per pixel, ground metres per pixel) at ``zoom``.

    Web Mercator units are metres only at the equator; away from it a unit is
    ``cos(latitude)`` metres, which is why the two numbers differ.
    """
    units = EARTH_CIRCUMFERENCE / (256 * 2**zoom)
    return units, units * math.cos(math.radians(latitude))


def describe_grid(path: Path) -> tuple[object, object, tuple[int, int]]:
    """Read the three properties that define a raster's grid."""
    with rasterio.open(path) as src:
        return src.crs, src.transform, (src.width, src.height)


def check_grid(output_path: Path, reference_path: Path) -> bool:
    """Assert ``output_path`` is co-registered with ``reference_path``.

    Identical CRS, transform and shape is exactly the property that makes
    cell-by-cell combination valid, so all three are compared and every
    mismatch is reported rather than only the first.
    """
    out_crs, out_transform, out_shape = describe_grid(output_path)
    ref_crs, ref_transform, ref_shape = describe_grid(reference_path)

    print(f"Grid check against {reference_path.name}")
    problems: list[str] = []
    if out_crs != ref_crs:
        problems.append(f"CRS {out_crs} != {ref_crs}")
    # Compare the six affine coefficients with a tolerance: they are floats
    # derived from the same tiling maths, so exact equality is too brittle.
    if not np.allclose(
        np.array(out_transform[:6], dtype=float),
        np.array(ref_transform[:6], dtype=float),
        rtol=0,
        atol=1e-6,
    ):
        problems.append(f"transform {tuple(out_transform[:6])} != {tuple(ref_transform[:6])}")
    if out_shape != ref_shape:
        problems.append(f"size {out_shape[0]}x{out_shape[1]} != {ref_shape[0]}x{ref_shape[1]}")

    if problems:
        for p in problems:
            print(f"  MISMATCH: {p}", file=sys.stderr)
        return False

    print(f"  OK — same CRS, transform and size ({out_shape[0]}x{out_shape[1]})")
    return True


def convert(
    input_path: Path,
    output_path: Path,
    *,
    zoom: int,
    resampling: str,
    nodata: int | None,
) -> None:
    print(f"Reading  {input_path}")
    with rasterio.open(input_path) as src:
        dtype = src.dtypes[0]
        file_nodata = src.nodata
        print(
            f"  {src.count} band(s), dtype={dtype}, CRS={src.crs}, "
            f"nodata={file_nodata}, size={src.width}x{src.height}"
        )
        if src.crs is None:
            raise SystemExit(
                f"error: {input_path.name} has no CRS, so it cannot be reprojected. "
                "Assign one with gdal_edit.py -a_srs EPSG:XXXX first."
            )
        if src.count != 1:
            raise SystemExit(
                f"error: expected a single-band class raster, got {src.count} bands. "
                "Combining reads band0 only."
            )
        # Latitude of the raster's centre, purely to report the true ground
        # resolution — the grid itself does not depend on it.
        bounds = src.bounds
        centre_lat = None
        try:
            _, south, _, north = rasterio.warp.transform_bounds(
                src.crs, "EPSG:4326", *bounds
            )
            centre_lat = (south + north) / 2
        except rasterio.errors.RasterioError:
            # Only the printed ground-resolution figure depends on this; the
            # output grid does not, so a projection failure must not stop work.
            pass

    # An explicit --nodata wins; otherwise the file's tag, falling back to the
    # 255 convention that class rasters in this folder follow.
    if nodata is None:
        nodata = int(file_nodata) if file_nodata is not None else DEFAULT_NODATA
        source = "file tag" if file_nodata is not None else "convention"
        print(f"Nodata value: {nodata} ({source})")
    else:
        print(f"Nodata value: {nodata} (--nodata)")

    if resampling in INTERPOLATING and np.issubdtype(np.dtype(dtype), np.integer):
        print(
            f"  WARNING: --resampling {resampling} blends neighbouring cells, but "
            f"dtype is {dtype} (class data). This INVENTS class values that are "
            "not in the source — use 'nearest' or 'mode' unless the band is "
            "genuinely continuous."
        )

    units, metres = ground_resolution(zoom, centre_lat if centre_lat else 0.0)
    print(f"Writing  {output_path}")
    print(
        f"  WebMercatorQuad zoom {zoom}: {units:.4f} units/px"
        + (f" (~{metres:.2f} m ground at {centre_lat:.2f} N)" if centre_lat else "")
    )

    # "deflate" profile: tiled, internally-overviewed, lossless compression.
    #
    # `zoom_level` is the reason this script exists — without it the strategy
    # picks a level per input and rasters stop sharing a grid. `nodata` makes
    # the warp fill reprojection padding with the sentinel, so it renders
    # transparent rather than as class 0.
    cog_translate(
        input_path,
        output_path,
        cog_profiles.get("deflate"),
        web_optimized=True,
        zoom_level=zoom,
        zoom_level_strategy="auto",
        resampling=resampling,
        overview_resampling=resampling,
        nodata=nodata,
        forward_band_tags=True,
        quiet=False,
    )

    print("Validating COG…")
    is_valid, errors, warnings = cog_validate(output_path)
    for w in warnings:
        print(f"  warning: {w}")
    for e in errors:
        print(f"  error:   {e}", file=sys.stderr)

    with rasterio.open(output_path) as dst:
        size = output_path.stat().st_size
        status = "valid COG" if is_valid else "NOT a valid COG"
        values = np.unique(dst.read(1))
        shown = ", ".join(str(int(v)) for v in values[:12])
        if len(values) > 12:
            shown += f", … ({len(values):,} distinct)"
        print(
            f"Wrote {output_path.name} ({size:,} bytes) — "
            f"{dst.width}x{dst.height}, {dst.crs}, {status}"
        )
        print(f"  values: {shown}")

    if not is_valid:
        raise SystemExit(1)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert a classified GeoTIFF to a COG pinned to the WebMercatorQuad "
            "grid, so several outputs align cell-for-cell."
        ),
    )
    parser.add_argument("input", type=Path, help="source GeoTIFF")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="output COG (default: <input>.cog.tif, the layers.json URL convention)",
    )
    units, metres = ground_resolution(DEFAULT_ZOOM, 51.09)
    parser.add_argument(
        "--zoom",
        type=int,
        default=DEFAULT_ZOOM,
        help=(
            f"WebMercatorQuad zoom level to pin the grid to (default {DEFAULT_ZOOM} = "
            f"{units:.4f} units/px, ~{metres:.2f} m ground at Limburg's latitude). "
            "Every raster that must be combined has to use the SAME value."
        ),
    )
    parser.add_argument(
        "--resampling",
        default=DEFAULT_RESAMPLING,
        choices=["nearest", "mode", "average", "bilinear", "cubic"],
        help=(
            f"resampling method (default {DEFAULT_RESAMPLING}); 'nearest' and 'mode' "
            "preserve class values, the others blend them"
        ),
    )
    parser.add_argument(
        "--nodata",
        type=int,
        default=None,
        help=f"nodata value (default: the file's tag, else {DEFAULT_NODATA} by convention)",
    )
    parser.add_argument(
        "--expect-grid",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "after writing, assert the output shares CRS, transform and size with "
            "this reference COG; exits 2 if it does not"
        ),
    )
    args = parser.parse_args(argv[1:])

    if not args.input.exists():
        print(f"error: {args.input} not found", file=sys.stderr)
        return 1

    output_path = args.output or args.input.with_suffix(".cog.tif")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    convert(
        args.input,
        output_path,
        zoom=args.zoom,
        resampling=args.resampling,
        nodata=args.nodata,
    )

    if args.expect_grid is not None:
        if not args.expect_grid.exists():
            print(f"error: --expect-grid {args.expect_grid} not found", file=sys.stderr)
            return 2
        if not check_grid(output_path, args.expect_grid):
            print(
                "error: output is NOT on the same grid as the reference — "
                "combining these rasters cell-by-cell would be wrong.",
                file=sys.stderr,
            )
            return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
