#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "rio-cogeo>=5",
#   "rasterio>=1.3",
# ]
# ///
"""Convert a regular GeoTIFF to a Cloud-Optimized GeoTIFF (COG).

The output is a valid COG that this app renders via the ``"cog"`` format entry
in ``public/layers.json`` — the same path that handles the existing
``example-cog`` layer (through ``@geomatico/maplibre-cog-protocol``).

Band count is preserved: a 1-band input produces a 1-band COG, a 3-band input a
3-band COG, etc. The source ``nodata`` value is carried through so the client can
render nodata pixels transparently.

Output is **web-optimized** by default (reprojected/aligned to the Web-Mercator
tiling grid, EPSG:3857) so it renders fastest in the map. Pass
``--no-web-optimized`` to keep the source CRS and grid instead.

Usage:
    # Default (web-optimized): data/input.tif -> data/input.cog.tif
    python3 convert-tif-to-cog.py path/to/input.tif

    # Explicit input/output:
    python3 convert-tif-to-cog.py path/to/in.tif path/to/out.cog.tif

    # Keep the source CRS/grid (no Web-Mercator reprojection):
    python3 convert-tif-to-cog.py path/to/input.tif --no-web-optimized

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

import sys
from pathlib import Path

import rasterio
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles


def convert(input_path: Path, output_path: Path, web_optimized: bool) -> None:
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

    # "deflate" profile: tiled, internally-overviewed, lossless DEFLATE compression.
    # cog_translate preserves the source band count and (by default) nodata.
    dst_profile = cog_profiles.get("deflate")

    print(f"Writing  {output_path}" + (" (web-optimized)" if web_optimized else ""))
    cog_translate(
        input_path,
        output_path,
        dst_profile,
        web_optimized=web_optimized,
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
        print(
            f"Wrote {output_path.name} ({size:,} bytes) — {dst.count} band(s), {status}"
        )

    if not is_valid:
        raise SystemExit(1)


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("-")]
    # Web-optimized (Web-Mercator-aligned) output is the default; opt out with
    # --no-web-optimized to keep the source CRS/grid.
    web_optimized = "--no-web-optimized" not in argv[1:]

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

    convert(input_path, output_path, web_optimized)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
