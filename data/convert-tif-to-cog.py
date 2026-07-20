#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "rio-cogeo>=5",
#   "rasterio>=1.3",
#   "numpy>=1.24",
#   "gdal>=3.6",
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

Pass ``--priority "v1,v2,…"`` to keep **thin/sparse classes visible when zoomed
out** (e.g. rasterized panden/buildings). Normally COG overviews are built by
decimation that drops a lone feature pixel among its background neighbors, so
the feature fades at low zoom. With ``--priority`` the COG's overviews are
rewritten with a "priority wins" reduction: at each level a cell takes a
priority value if ANY source cell under it had one, plus a small dilation per
level so a single building pixel keeps propagating up the pyramid. The
full-resolution base band is untouched (no thickening when zoomed in); only the
overviews are biased. Requires a single-band input and is mutually exclusive
with ``--colors`` — the output is a single-band COG, so style the priority
class with a GeoStyler rule in layers.json (see the ``geostyler`` block below).

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

    # Keep sparse buildings (class value 1) visible when zoomed out. Produces a
    # single-band COG — style value 1 with a GeoStyler rule in layers.json:
    python3 convert-tif-to-cog.py path/to/panden.tif --priority "1"

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


def build_luts(
    colors: list[tuple[int, int, int]],
    nodata_rgb: tuple[int, int, int],
    max_value: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-channel lookup tables indexed by class value: value -> RGB. Every
    value defaults to the nodata sentinel; mapped values are filled from
    ``colors`` (positional). Sized to cover ``max_value`` and all colors."""
    table_len = max(max_value + 1, len(colors))
    r_lut = np.full(table_len, nodata_rgb[0], dtype=np.uint8)
    g_lut = np.full(table_len, nodata_rgb[1], dtype=np.uint8)
    b_lut = np.full(table_len, nodata_rgb[2], dtype=np.uint8)
    for value, (r, g, b) in enumerate(colors):
        if value < table_len:
            r_lut[value], g_lut[value], b_lut[value] = r, g, b
    return r_lut, g_lut, b_lut


def apply_lut(
    band: np.ndarray,
    luts: tuple[np.ndarray, np.ndarray, np.ndarray],
    nodata_rgb: tuple[int, int, int],
    src_nodata: float | None,
) -> np.ndarray:
    """Map a single-band class array to a (3, H, W) uint8 RGB array via ``luts``.
    Out-of-range / negative values and the source nodata become the RGB nodata
    sentinel (rendered transparent). Pure — reused for the base band and every
    manually-built overview level so overview colors are exact rule colors."""
    r_lut, g_lut, b_lut = luts
    table_len = r_lut.shape[0]
    idx = band.astype(np.int64)
    in_range = (idx >= 0) & (idx < table_len)
    safe = np.where(in_range, idx, 0)

    rgb = np.stack([r_lut[safe], g_lut[safe], b_lut[safe]])
    nodata_col = np.array(nodata_rgb, dtype=np.uint8)[:, None]
    rgb[:, ~in_range] = nodata_col
    if src_nodata is not None:
        rgb[:, band == src_nodata] = nodata_col
    return rgb


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
    luts = build_luts(colors, nodata_rgb, int(band.max(initial=0)))
    rgb = apply_lut(band, luts, nodata_rgb, src.nodata)

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


def _priority_pool2x(mask: np.ndarray) -> np.ndarray:
    """2×2 OR-pooling of a boolean priority mask (a cell is set if ANY of its
    four source cells is). Odd trailing row/column is dropped — the COG's
    overview dimensions are floor(n/2), matching this."""
    h, w = mask.shape
    h2, w2 = h // 2, w // 2
    m = mask[: h2 * 2, : w2 * 2]
    return (
        m[0::2, 0::2] | m[1::2, 0::2] | m[0::2, 1::2] | m[1::2, 1::2]
    )


def _dilate(mask: np.ndarray, iterations: int) -> np.ndarray:
    """Binary dilation with a 3×3 (8-connectivity) structuring element, numpy
    only (no scipy). Grows priority blobs by `iterations` pixels so they keep
    surviving further decimation at coarser overview levels."""
    out = mask
    for _ in range(iterations):
        p = np.pad(out, 1)
        out = (
            p[1:-1, 1:-1]
            | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
            | p[:-2, :-2] | p[:-2, 2:] | p[2:, :-2] | p[2:, 2:]
        )
    return out


def rewrite_priority_overviews(cog_path: Path, priority: list[int]) -> None:
    """Overwrite a single-band COG's overviews with priority-preserving,
    progressively-dilated decimations of the base band, so sparse priority
    classes (buildings) stay visible when zoomed out. The base (full-res) band
    is left untouched. Requires the GDAL Python bindings (osgeo)."""
    from osgeo import gdal

    gdal.UseExceptions()
    ds = gdal.Open(str(cog_path), gdal.GA_Update)
    if ds is None:
        raise RuntimeError(f"GDAL could not open {cog_path} for overview rewrite")
    try:
        band = ds.GetRasterBand(1)
        n_ovr = band.GetOverviewCount()
        if n_ovr == 0:
            print("  (no overviews to rewrite)")
            return

        base = band.ReadAsArray()
        base_priority = np.isin(base, priority)
        pri_value = min(priority)  # value written where a coarse cell wins

        # Walk levels coarse-relative: for each overview compute the OR-pooled
        # priority mask at that level and dilate more as we go coarser, so a
        # lone building keeps a footprint at every zoom.
        written = []
        for i in range(n_ovr):
            ovr = band.GetOverview(i)
            ow, oh = ovr.XSize, ovr.YSize
            # Factor from full-res to this overview (GDAL guarantees ~2^k).
            fx = round(ds.RasterXSize / ow)
            level = max(1, round(np.log2(fx)))

            # Non-priority appearance at this level: GDAL's existing (nearest)
            # decimation is a fine base; we only paint priority cells on top.
            existing = ovr.ReadAsArray()

            # Pool the base priority mask down to this level: OR-pool each
            # halving (a coarse cell wins if ANY source cell is priority — so a
            # lone building never fully vanishes), then a single 1px dilation at
            # the overview grid so it reads as a small dot. Dilating once at the
            # end (not per halving) keeps sparse features visible WITHOUT the
            # footprint compounding into a flood at very coarse levels.
            mask = base_priority
            for _h in range(level):
                mask = _priority_pool2x(mask)
            mask = _dilate(mask, 1)
            # Size guard: crop/pad the pooled mask to the overview's exact dims.
            mask = mask[:oh, :ow]
            if mask.shape != (oh, ow):
                fitted = np.zeros((oh, ow), dtype=bool)
                fitted[: mask.shape[0], : mask.shape[1]] = mask
                mask = fitted

            out = existing.copy()
            out[mask] = pri_value
            ovr.WriteArray(out)
            written.append(f"{ow}x{oh}(1/{fx})")

        band.FlushCache()
        ds.FlushCache()
        print(f"  Priority overviews rewritten: {', '.join(written)}")
    finally:
        ds = None


def convert(
    input_path: Path,
    output_path: Path,
    web_optimized: bool,
    colors: list[tuple[int, int, int]] | None,
    priority: list[int] | None,
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

        if priority is not None and src.count != 1:
            raise ValueError(
                f"--priority requires a single-band input, but got {src.count} bands"
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

    # --priority: replace the freshly built overviews with priority-dilated
    # ones so sparse features (panden) stay visible when zoomed out, WITHOUT
    # altering the full-resolution base band. Runs on the single class band of
    # the already-warped COG (output grid), so it composes with web-optimize.
    if priority is not None:
        rewrite_priority_overviews(output_path, priority)

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

    # --priority "v1,v2,…": class values to keep visible in overviews (buildings).
    priority: list[int] | None = None
    priority_args = [a for a in flags if a.startswith("--priority")]
    if priority_args:
        raw = priority_args[-1]
        if "=" in raw:
            raw = raw.split("=", 1)[1]
        else:
            i = flags.index(raw)
            if i + 1 < len(flags):
                raw = flags[i + 1]
                args = [a for a in args if a != raw]
        try:
            priority = [int(v.strip()) for v in raw.split(",") if v.strip()]
        except ValueError:
            print(f"error: --priority expects integer class values, got '{raw}'", file=sys.stderr)
            return 1
        if not priority:
            print("error: --priority given but no valid values parsed", file=sys.stderr)
            return 1

    if priority is not None and colors is not None:
        print(
            "error: --priority and --colors are mutually exclusive. --priority keeps "
            "a single-band COG (dilated overviews on the class band) — style it with "
            "GeoStyler rules in layers.json. --colors bakes RGB and can't carry the "
            "class-band dilation. Use one or the other.",
            file=sys.stderr,
        )
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

    convert(input_path, output_path, web_optimized, colors, priority)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
