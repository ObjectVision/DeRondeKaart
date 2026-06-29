#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "rio-cogeo>=5",
#   "rasterio>=1.3",
#   "numpy>=1.24",
# ]
# ///
"""Convert a regular GeoTIFF to a Cloud-Optimized GeoTIFF (COG).

The output is a valid COG that this app renders via the ``"cog"`` format entry
in ``public/layers.json`` — the same path that handles the existing
``example-cog`` layer (through ``@geomatico/maplibre-cog-protocol``).

Band count is preserved by default: a 1-band input produces a 1-band COG, a
3-band input a 3-band COG, etc. The source ``nodata`` value is carried through so
the client can render nodata pixels transparently.

Pass ``--colors`` to **colorize a single-band raster into a 3-band RGB COG**: a
comma-separated, positional list of hex colors where the 1st color maps to pixel
value 0, the 2nd to value 1, and so on. Any pixel value without a color (and the
source nodata) becomes RGB nodata — rendered transparent. When ``--colors`` is
given the output is ALWAYS an RGB COG (no ``geostyler`` needed in layers.json).

Output is **web-optimized** by default (reprojected/aligned to the Web-Mercator
tiling grid, EPSG:3857) so it renders fastest in the map. Pass
``--no-web-optimized`` to keep the source CRS and grid instead. Extra pixels
created by the reprojection warp are filled with nodata (transparent).

Usage:
    # Default (web-optimized): data/input.tif -> data/input.cog.tif
    python3 convert-tif-to-cog.py path/to/input.tif

    # Explicit input/output:
    python3 convert-tif-to-cog.py path/to/in.tif path/to/out.cog.tif

    # Keep the source CRS/grid (no Web-Mercator reprojection):
    python3 convert-tif-to-cog.py path/to/input.tif --no-web-optimized

    # Colorize a single-band raster to RGB (value 0->1st color, 1->2nd, ...):
    python3 convert-tif-to-cog.py path/to/classes.tif \
        --colors "#d7f0b2,#c1d699,#acbf81,#98a86a"

If you have ``uv`` installed you can run this without managing dependencies:
    uv run convert-tif-to-cog.py path/to/input.tif

After conversion, add to ``public/layers.json``. A single-band COG can be styled
thematically with GeoStyler rules, using ``band0`` (band1 -> ``band1``, ...) as
the filter property — the same rule syntax as the geoparquet layers:

    {
      "id": "my-cog",
      "name": "My COG",
      "source": "https://data.woonzorglimburg.nl/cog/my.cog.tif",
      "format": "cog",
      "style": { "opacity": 0.8 },
      "geostyler": {
        "name": "band0 classes",
        "rules": [
          {
            "name": "11 tot 25",
            "filter": ["&&", [">=", "band0", 11], ["<", "band0", 25]],
            "symbolizers": [{ "kind": "Fill", "color": "#61BE7B" }]
          },
          {
            "name": "25 of meer",
            "filter": [">=", "band0", 25],
            "symbolizers": [{ "kind": "Fill", "color": "#FF6024" }]
          }
        ]
      }
    }

Pixels not matching any rule (and nodata pixels) render transparent.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles


def parse_hex(color: str) -> tuple[int, int, int]:
    """Parse a "#rrggbb" (or "rrggbb") hex string to an (r, g, b) 0–255 tuple."""
    h = color.strip().lstrip("#")
    if len(h) != 6:
        raise ValueError(f"invalid hex color '{color}' (expected #rrggbb)")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def pick_nodata_rgb(colors: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    """Pick an RGB triple to use as the transparent/nodata sentinel.

    The cog protocol renders an RGB pixel transparent only when R==G==B==nodata,
    so the sentinel must be a single value repeated across the 3 bands AND must
    not collide with any mapped color. Try a few greyscale values until one is
    free; greyscale is safe because the check compares each band to one value.
    """
    used = set(colors)
    for v in (0, 255, 1, 254, 128):
        if (v, v, v) not in used:
            return (v, v, v)
    # Extremely unlikely fallback: scan all greys.
    for v in range(256):
        if (v, v, v) not in used:
            return (v, v, v)
    raise ValueError("could not find a free nodata color (all greys are in use)")


def colorize_to_rgb(
    src: rasterio.io.DatasetReader,
    colors: list[tuple[int, int, int]],
    out_path: Path,
) -> tuple[int, int, int]:
    """Map a single-band raster to a 3-band RGB GeoTIFF using a positional color
    list (value 0 -> colors[0], 1 -> colors[1], ...). Unmapped values and source
    nodata become the RGB nodata sentinel (rendered transparent). Returns the
    chosen nodata RGB triple.
    """
    if src.count != 1:
        raise ValueError(
            f"--colors requires a single-band input, but got {src.count} bands"
        )

    nodata_rgb = pick_nodata_rgb(colors)
    band = src.read(1)

    # Build per-channel lookup tables indexed by pixel value. Default every value
    # to the nodata sentinel; then fill in the mapped values.
    vmax = int(band.max(initial=0))
    table_len = max(vmax + 1, len(colors))
    r_lut = np.full(table_len, nodata_rgb[0], dtype=np.uint8)
    g_lut = np.full(table_len, nodata_rgb[1], dtype=np.uint8)
    b_lut = np.full(table_len, nodata_rgb[2], dtype=np.uint8)
    for value, (r, g, b) in enumerate(colors):
        if value < table_len:
            r_lut[value], g_lut[value], b_lut[value] = r, g, b

    # Clamp out-of-range / negative values to nodata via a safe index.
    idx = band.astype(np.int64)
    in_range = (idx >= 0) & (idx < table_len)
    safe = np.where(in_range, idx, 0)

    rgb = np.stack([r_lut[safe], g_lut[safe], b_lut[safe]])
    # Out-of-range pixels -> nodata
    rgb[:, ~in_range] = np.array(nodata_rgb, dtype=np.uint8)[:, None]
    # Source nodata -> nodata sentinel
    if src.nodata is not None:
        mask = band == src.nodata
        rgb[:, mask] = np.array(nodata_rgb, dtype=np.uint8)[:, None]

    profile = src.profile.copy()
    profile.update(
        count=3,
        dtype="uint8",
        nodata=nodata_rgb[0],  # single value; renderer checks all bands == it
        photometric="RGB",
    )
    # Drop any single-band colormap/colorinterp leftovers.
    profile.pop("colormap", None)

    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(rgb)
        dst.colorinterp = [
            rasterio.enums.ColorInterp.red,
            rasterio.enums.ColorInterp.green,
            rasterio.enums.ColorInterp.blue,
        ]
    return nodata_rgb


def convert(
    input_path: Path,
    output_path: Path,
    web_optimized: bool,
    colors: list[tuple[int, int, int]] | None,
) -> None:
    print(f"Reading  {input_path}")
    with rasterio.open(input_path) as src:
        print(
            f"  {src.count} band(s), dtype={src.dtypes[0]}, "
            f"CRS={src.crs}, nodata={src.nodata}, size={src.width}x{src.height}"
        )
        if src.crs is None:
            print("  Warning: input has no CRS — the COG may not position correctly")
        elif src.crs.to_epsg() != 3857 and not web_optimized:
            print(
                f"  Note: source CRS is {src.crs}, not EPSG:3857 (Web Mercator), "
                "and --no-web-optimized was given. The cog protocol reprojects on "
                "the fly, but a web-optimized COG renders fastest."
            )

        # When colors are given, first colorize the single band to a temporary
        # 3-band RGB GeoTIFF; cog_translate then turns THAT into the COG.
        tmp_rgb: Path | None = None
        if colors is not None:
            # Close mkstemp's fd immediately — rasterio reopens the path itself,
            # and on Windows an open handle would block the later unlink().
            fd, tmp_name = tempfile.mkstemp(suffix=".rgb.tif")
            os.close(fd)
            tmp_rgb = Path(tmp_name)
            print(
                f"  Colorizing 1 band -> RGB using {len(colors)} color(s) "
                "(value 0..N positional)"
            )
            nodata_rgb = colorize_to_rgb(src, colors, tmp_rgb)
            print(f"  Transparent (nodata) RGB = {nodata_rgb}")
            translate_src: Path = tmp_rgb
            nodata_for_warp: float | None = float(nodata_rgb[0])
        else:
            translate_src = input_path
            nodata_for_warp = src.nodata

    # "deflate" profile: tiled, internally-overviewed, lossless DEFLATE compression.
    dst_profile = cog_profiles.get("deflate")

    print(f"Writing  {output_path}" + (" (web-optimized)" if web_optimized else ""))
    # `nodata` makes warp fill the extra pixels (from reprojection) with the
    # nodata value, so they render transparent rather than black.
    cog_translate(
        translate_src,
        output_path,
        dst_profile,
        web_optimized=web_optimized,
        nodata=nodata_for_warp,
        forward_band_tags=True,
        quiet=False,
    )

    if tmp_rgb is not None:
        try:
            tmp_rgb.unlink(missing_ok=True)
        except OSError:
            pass  # best-effort temp cleanup; the COG is already written

    print("Validating COG…")
    is_valid, errors, warnings = cog_validate(output_path)
    for w in warnings:
        print(f"  warning: {w}")
    for e in errors:
        print(f"  error:   {e}", file=sys.stderr)

    with rasterio.open(output_path) as dst:
        size = output_path.stat().st_size
        status = "valid COG" if is_valid else "NOT a valid COG"
        print(
            f"Wrote {output_path.name} ({size:,} bytes) — {dst.count} band(s), {status}"
        )

    if not is_valid:
        raise SystemExit(1)


def main(argv: list[str]) -> int:
    flags = argv[1:]
    args = [a for a in flags if not a.startswith("-")]
    # Web-optimized (Web-Mercator-aligned) output is the default; opt out with
    # --no-web-optimized to keep the source CRS/grid.
    web_optimized = "--no-web-optimized" not in flags

    # --colors "#rrggbb,#rrggbb,..." (positional: value 0 -> 1st color, etc.).
    # When present the output is always a 3-band RGB COG.
    colors: list[tuple[int, int, int]] | None = None
    color_args = [a for a in flags if a.startswith("--colors")]
    if color_args:
        raw = color_args[-1]
        if "=" in raw:
            raw = raw.split("=", 1)[1]
        else:
            # "--colors" followed by the value as a separate token
            i = flags.index(raw)
            if i + 1 < len(flags):
                raw = flags[i + 1]
                args = [a for a in args if a != raw]
        try:
            colors = [parse_hex(c) for c in raw.split(",") if c.strip()]
        except ValueError as err:
            print(f"error: {err}", file=sys.stderr)
            return 1
        if not colors:
            print("error: --colors given but no valid colors parsed", file=sys.stderr)
            return 1

    if len(args) < 1 or len(args) > 2:
        print(__doc__)
        return 2

    input_path = Path(args[0])
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if len(args) == 2:
        output_path = Path(args[1])
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        # input.tif -> input.cog.tif
        output_path = input_path.with_suffix(".cog.tif")

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    convert(input_path, output_path, web_optimized, colors)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
