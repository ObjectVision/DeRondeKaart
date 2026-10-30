#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Combine the 3-30-300 tree rules per gemeente, wijk and buurt into ONE layer.

The tree-rule data comes as three GeoJSONs, one per area level, each with the
same rule fields (``rule_3``, ``rule_30``, ``rule_300``,
``rule_3_30_300_classified``):

    bomen_lb/bomen_gemeente_lb_2026.geojson   -> z0-9
    bomen_lb/bomen_wijk_lb_2026.geojson       -> z10-11
    bomen_lb/bomen_buurt_lb_2026.geojson      -> z12-14

This driver stacks them as zoom bands of a single PMTiles layer ``bomen``, so
the map shows gemeenten when zoomed out, wijken at city level and buurten when
zoomed in — with one style per rule instead of one per rule AND level.

Before tiling, every feature gets two extra properties so one featureinfo
template works at every zoom:

    niveau    "gemeente" | "wijk" | "buurt"
    statcode  the GM_/WK_/BU_CODE of that level

The staged GeoJSONs are written beside the output; the PMTiles step is
``convert-geojson-to-pmtiles.py`` with one ``--layer bomen=<file>@<band>`` per
level. That step needs the GDAL bindings, which on Windows come from OSGeo4W
rather than pip; the current interpreter is used when it has them, otherwise
``C:\\OSGeo4W\\bin\\python-qgis.bat``.

Usage:
    python3 build-3-30-300-pmtiles.py

    # Switch to wijk after z8 and to buurt after z10:
    python3 build-3-30-300-pmtiles.py --bands 8,10

    # Other input folder / output path:
    python3 build-3-30-300-pmtiles.py --input-dir path/to/bomen_lb -o out.pmtiles
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

# Only used as a fallback when the current interpreter has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

DEFAULT_INPUT_DIR = Path(
    r"C:\LocalData\woonzorgwijzer_clientside_rendering\cbs100m_grid_data\2026\bomen_lb"
)
DEFAULT_OUTPUT = HERE / "bomen_lb" / "bomen_3_30_300_lb_2026.pmtiles"
LAYER_NAME = "bomen"
MAXZOOM = 14

# (level, input file name, code field), coarse to fine — the order of the bands.
LEVELS = (
    ("gemeente", "bomen_gemeente_lb_2026.geojson", "GM_CODE"),
    ("wijk", "bomen_wijk_lb_2026.geojson", "WK_CODE"),
    ("buurt", "bomen_buurt_lb_2026.geojson", "BU_CODE"),
)

# Last zoom of the gemeente band and of the wijk band.
DEFAULT_BANDS = (9, 11)


def parse_bands(value: str) -> tuple[int, int]:
    """Parse "9,11" into the last zoom of the gemeente and wijk bands."""
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise argparse.ArgumentTypeError(f"--bands expects two zooms like 9,11, got {value!r}")
    first, second = int(parts[0]), int(parts[1])
    if not 0 <= first < second < MAXZOOM:
        raise argparse.ArgumentTypeError(
            f"--bands needs 0 <= gemeente end < wijk end < {MAXZOOM}, got {value!r}"
        )
    return first, second


def zoom_bands(ends: tuple[int, int]) -> list[tuple[int, int]]:
    """The three (minzoom, maxzoom) bands, gemeente first."""
    first, second = ends
    return [(0, first), (first + 1, second), (second + 1, MAXZOOM)]


def pmtiles_interpreter() -> list[str]:
    """An interpreter that can import the GDAL bindings (``osgeo``)."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for candidate in candidates:
        result = subprocess.run(
            candidate + ["-c", "import osgeo"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return candidate
    raise SystemExit(
        "error: no interpreter found with the GDAL bindings (osgeo).\n"
        f"  Windows/OSGeo4W:  expected {OSGEO4W_PYTHON}\n"
        "  conda:            conda install -c conda-forge gdal"
    )


def stage(level: str, source: Path, code_field: str, target: Path) -> int:
    """Copy one level's GeoJSON with ``niveau`` and ``statcode`` added."""
    data = json.loads(source.read_text(encoding="utf-8-sig"))
    features = data.get("features", [])
    for feature in features:
        properties = feature.setdefault("properties", {}) or {}
        properties["niveau"] = level
        properties["statcode"] = properties.get(code_field)
        feature["properties"] = properties
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return len(features)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Combine the gemeente/wijk/buurt 3-30-300 GeoJSONs into one "
            f"zoom-banded PMTiles layer named {LAYER_NAME!r}."
        ),
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT_DIR,
        metavar="DIR",
        help=f"Folder with the three bomen_*_lb_2026.geojson files (default: {DEFAULT_INPUT_DIR})",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        metavar="PATH",
        help=f"Output .pmtiles path (default: {DEFAULT_OUTPUT.relative_to(HERE)})",
    )
    parser.add_argument(
        "--bands",
        type=parse_bands,
        default=DEFAULT_BANDS,
        metavar="9,11",
        help=(
            "Last zoom of the gemeente band and of the wijk band; buurt runs "
            f"to z{MAXZOOM} (default: {DEFAULT_BANDS[0]},{DEFAULT_BANDS[1]})"
        ),
    )
    args = parser.parse_args(argv[1:])

    if not GEOJSON_TO_PMTILES.is_file():
        print(f"error: missing sibling script: {GEOJSON_TO_PMTILES}", file=sys.stderr)
        return 2

    output = args.output.resolve()
    staging_dir = output.parent

    command = pmtiles_interpreter() + [str(GEOJSON_TO_PMTILES), "-o", str(output)]
    for (level, file_name, code_field), (lo, hi) in zip(LEVELS, zoom_bands(args.bands)):
        source = args.input_dir / file_name
        if not source.is_file():
            print(f"error: input not found: {source}", file=sys.stderr)
            return 2
        staged = staging_dir / f"{LAYER_NAME}_{level}.geojson"
        count = stage(level, source, code_field, staged)
        print(f"  {level:<8} z{lo}-{hi}: {count} feature(s) from {source.name}")
        command += ["--layer", f"{LAYER_NAME}={staged}@{lo}-{hi}"]

    print(f"\nBuilding {output.name}…")
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        print(f"error: building {output.name} failed (exit {result.returncode})", file=sys.stderr)
        return result.returncode

    print(f"\nDone — {output} ({output.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
