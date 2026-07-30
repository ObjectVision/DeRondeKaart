#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "numpy>=1.24",
#   "pyogrio>=0.7",
#   "rasterio>=1.3",
#   "shapely>=2.0",
# ]
# ///
"""Combine the per-year class rasters in ``tif/<year>/`` into ONE PMTiles archive.

``tif/`` holds one folder per forecast year (2025…2045), each with the same set
of classified rasters (``aandeel_j0_17_m5``, ``oosr_2_m5``, …) on an identical
grid. This driver chains the two existing converters over a chosen set of years:

    tif/<year>/<name>.tif
      -> convert-tif-to-geojson.py   -> tif/<year>/<name>.geojson
      -> convert-geojson-to-pmtiles.py (one --layer per file)
      -> tif/years.pmtiles

Every raster becomes its own **layer** in the archive, named ``<year>_<name>``,
so ``tif/2025/aandeel_j0_17_m5.tif`` lands as layer ``2025_aandeel_j0_17_m5``.
The map style then switches years by toggling which layer it draws — one archive
request instead of one per year.

By default only the 5-year steps (2025, 2030, 2035, 2040, 2045) are built; the
in-between years exist on disk but are skipped. Pass ``--years`` to change that.

The intermediate GeoJSONs are kept beside their rasters so the archive can be
rebuilt (different zooms, different year subset) without re-running the slow
polygonize step. Pass ``--clean-geojson`` to remove them afterwards, or
``--skip-existing`` to reuse the ones already written.

The two stages need **different interpreters** and the script finds them itself:
vectorising needs geopandas/rasterio (pip), while the PMTiles step needs the GDAL
bindings, which on Windows come from OSGeo4W and not from pip — see
``convert-geojson-to-pmtiles.py``. A single interpreter rarely has both, so each
stage is run with one that can import what it needs, starting with the current
one and falling back to ``C:\\OSGeo4W\\bin\\python-qgis.bat``. Just run it with
the python that has geopandas; pass ``--no-pmtiles`` if GDAL is unavailable.

Usage:
    # Default: the 5 five-year steps -> tif/years.pmtiles
    python3 build-years-pmtiles.py

    # A different set of years, and a different output:
    python3 build-years-pmtiles.py --years 2025,2035,2045 -o tif/steps.pmtiles

    # Reuse GeoJSONs from an earlier run (skip the polygonize stage):
    python3 build-years-pmtiles.py --skip-existing

    # Vectorise only, stop before building the archive:
    python3 build-years-pmtiles.py --no-pmtiles
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
TIF_ROOT = HERE / "tif"

# Where OSGeo4W puts its interpreter on Windows. Only used as a fallback when
# the current one has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

# The 5-year steps. The in-between folders (2026-2029, …) are deliberately not
# built by default — they would multiply the archive size for little gain.
DEFAULT_YEARS = ("2025", "2030", "2035", "2040", "2045")
DEFAULT_OUTPUT = TIF_ROOT / "years.pmtiles"

# Matches the validated default of convert-tif-to-geojson.py.
DEFAULT_SIMPLIFY = 10.0


def has_module(interpreter: list[str], module: str) -> bool:
    """Whether ``interpreter`` can import ``module``."""
    result = subprocess.run(
        interpreter + ["-c", f"import {module}"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def resolve_interpreters(*, need_pmtiles: bool) -> tuple[list[str], list[str] | None]:
    """Find an interpreter for each stage, which are rarely the same one.

    The two converters have dependencies that, on Windows, usually live in
    different interpreters: geopandas/rasterio come from pip, while the GDAL
    bindings come from OSGeo4W (there is no usable GDAL wheel — see
    ``convert-geojson-to-pmtiles.py``). Neither install tends to have both, so
    rather than making the caller pick, each stage gets an interpreter that can
    actually import what it needs.
    """
    current = [sys.executable]
    candidates = [current]

    # A sibling python.exe next to an OSGeo4W .bat, and the .bat itself.
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for name in ("python-qgis.bat", "python3.exe", "python.exe"):
        found = shutil.which(name)
        if found and [found] not in candidates:
            candidates.append([found])

    vector_python = next(
        (c for c in candidates if has_module(c, "geopandas")),
        None,
    )
    if vector_python is None:
        raise SystemExit(
            "error: no interpreter found with geopandas/rasterio installed.\n"
            "  install:  pip install geopandas rasterio shapely pyogrio\n"
            "  (or run this script with that interpreter)"
        )

    def label(interpreter: list[str]) -> str:
        return Path(interpreter[0]).name

    print(f"Vectorising with:  {label(vector_python)}")

    if not need_pmtiles:
        return vector_python, None

    pmtiles_python = next(
        (c for c in candidates if has_module(c, "osgeo")),
        None,
    )
    if pmtiles_python is None:
        raise SystemExit(
            "error: no interpreter found with the GDAL bindings (osgeo), which\n"
            "       the PMTiles step needs.\n"
            f"  Windows/OSGeo4W:  expected {OSGEO4W_PYTHON}\n"
            "  conda:            conda install -c conda-forge gdal\n"
            "  Pass --no-pmtiles to stop after vectorising."
        )

    print(f"PMTiles with:      {label(pmtiles_python)}")
    return vector_python, pmtiles_python


def parse_years(value: str) -> list[str]:
    """Parse a "2025,2030" year list."""
    years = [part.strip() for part in value.split(",") if part.strip()]
    if not years:
        raise argparse.ArgumentTypeError("--years given but no values parsed")
    for year in years:
        if not year.isdigit():
            raise argparse.ArgumentTypeError(
                f"--years expects numeric folder names, got {year!r}"
            )
    return years


def layer_name(year: str, tif: Path) -> str:
    """Layer name for one raster: ``<year>_<filename without extension>``."""
    return f"{year}_{tif.stem}"


def collect(years: list[str]) -> list[tuple[str, Path]]:
    """Find every .tif under the given year folders, as (layer name, path)."""
    found: list[tuple[str, Path]] = []
    for year in years:
        folder = TIF_ROOT / year
        if not folder.is_dir():
            raise SystemExit(f"error: year folder not found: {folder}")

        tifs = sorted(folder.glob("*.tif"))
        if not tifs:
            raise SystemExit(f"error: no .tif files in {folder}")

        for tif in tifs:
            found.append((layer_name(year, tif), tif))
        print(f"  {year}: {len(tifs)} raster(s)")
    return found


def vectorize(
    sources: list[tuple[str, Path]],
    *,
    interpreter: list[str],
    simplify: float,
    skip_existing: bool,
) -> list[tuple[str, Path]]:
    """Run convert-tif-to-geojson.py over every raster, returning the GeoJSONs."""
    results: list[tuple[str, Path]] = []
    total = len(sources)

    for index, (name, tif) in enumerate(sources, start=1):
        geojson = tif.with_suffix(".geojson")
        print(f"\n[{index}/{total}] {name}")

        if skip_existing and geojson.is_file():
            print(f"  reusing {geojson.name} ({geojson.stat().st_size:,} bytes)")
            results.append((name, geojson))
            continue

        command = interpreter + [
            str(TIF_TO_GEOJSON),
            str(tif),
            str(geojson),
            "--simplify",
            str(simplify),
        ]
        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            sys.stdout.write(result.stdout)
            sys.stderr.write(result.stderr)
            raise SystemExit(
                f"error: vectorising {tif.name} failed (exit {result.returncode})"
            )

        # Echo just the summary line rather than the full per-file chatter.
        for line in result.stdout.splitlines():
            if line.startswith("Wrote ") or line.startswith("  "):
                if line.startswith("Wrote ") or "regions" in line:
                    print(f"  {line.strip()}")

        results.append((name, geojson))

    return results


def build_pmtiles(
    layers: list[tuple[str, Path]],
    output: Path,
    *,
    interpreter: list[str],
) -> None:
    """Run convert-geojson-to-pmtiles.py with one --layer per GeoJSON."""
    command = interpreter + [str(GEOJSON_TO_PMTILES), "-o", str(output)]
    for name, geojson in layers:
        # NAME=PATH is split at the FIRST '=', so Windows paths stay intact.
        command += ["--layer", f"{name}={geojson}"]

    print(f"\nBuilding {output.name} from {len(layers)} layer(s)…")
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"error: building {output.name} failed (exit {result.returncode})"
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Combine the per-year rasters in tif/<year>/ into one PMTiles "
            "archive, one layer per raster named <year>_<filename>."
        ),
    )
    parser.add_argument(
        "--years",
        type=parse_years,
        default=list(DEFAULT_YEARS),
        metavar="2025,2030",
        help=f"Year folders to include (default: {','.join(DEFAULT_YEARS)})",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        metavar="PATH",
        help=f"Output .pmtiles path (default: {DEFAULT_OUTPUT.name} in tif/)",
    )
    parser.add_argument(
        "--simplify",
        type=float,
        default=DEFAULT_SIMPLIFY,
        metavar="PCT",
        help=(
            "Percentage of vertices to keep when vectorising "
            f"(default: {DEFAULT_SIMPLIFY:g})"
        ),
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Reuse GeoJSONs that already exist instead of re-vectorising",
    )
    parser.add_argument(
        "--clean-geojson",
        action="store_true",
        help="Delete the intermediate GeoJSONs once the archive is built",
    )
    parser.add_argument(
        "--no-pmtiles",
        dest="build",
        action="store_false",
        help="Only vectorise; stop before building the archive",
    )
    args = parser.parse_args(argv[1:])

    for script in (TIF_TO_GEOJSON, GEOJSON_TO_PMTILES):
        if not script.is_file():
            print(f"error: missing sibling script: {script}", file=sys.stderr)
            return 2

    output = Path(args.output) if args.output else DEFAULT_OUTPUT
    if not output.is_absolute():
        output = (Path.cwd() / output).resolve()

    started = time.time()

    vector_python, pmtiles_python = resolve_interpreters(need_pmtiles=args.build)

    print(f"Collecting rasters from {len(args.years)} year folder(s)…")
    sources = collect(args.years)
    print(f"  {len(sources)} raster(s) total")

    layers = vectorize(
        sources,
        interpreter=vector_python,
        simplify=args.simplify,
        skip_existing=args.skip_existing,
    )

    if args.build:
        build_pmtiles(layers, output, interpreter=pmtiles_python)

    if args.clean_geojson:
        for _, geojson in layers:
            geojson.unlink(missing_ok=True)
        print(f"Removed {len(layers)} intermediate GeoJSON(s)")

    elapsed = time.time() - started
    if args.build:
        size = output.stat().st_size
        print(
            f"\nDone in {elapsed:.0f}s — {output.name} "
            f"({size:,} bytes), {len(layers)} layer(s)"
        )
    else:
        print(f"\nDone in {elapsed:.0f}s — {len(layers)} GeoJSON(s), archive skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
