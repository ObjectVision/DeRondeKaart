#!/usr/bin/env python3
"""Build the study-area masks of objectvision's WoonZorgwijzer variants.

One archive per variant, ``pmtiles/studyareas/studyarea_WZW<Naam>.pmtiles``,
layer ``studyarea``: ``id`` 1 is the veil, ``id`` 2 the area itself — the
schema the ``wzw_studiegebied`` style in each ``configs/objectvision/wzw_*``
``layers.json`` filters on.

The sources are GeoDMS exports in CRS84, one per WZW region. The script also
prints each area's extent with the ``center`` / ``zoom`` written into the
variant's item in ``configs/objectvision/map.json``: the zoom fits the area
into a 1100x700 px map (512 px tiles), rounded down to 0.05 — on a smaller
screen than that, part of the area falls outside the opening view.

The tiling and upload helpers are ``build-wijk-buurt.py``'s.

Usage:
    python data/build-wzw-studyareas.py             # build, print center/zoom
    python data/build-wzw-studyareas.py --upload    # ...and publish to ov-data
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SOURCE_DIR = Path("C:/LocalData/woonzorgwijzer_clientside_rendering/cbs100m_grid_data/2026/studyareas")
OUT_DIR = HERE / "pmtiles" / "studyareas"
REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/studyareas"
# The veil reaches across Europe: z14 means tens of millions of tiles. z12
# (as the wonenenzorgopdekaart mask) is ~0.5M, and MapLibre overzooms beyond.
MAXZOOM = 12

# variant id -> source name (studyarea_WZW<name>.geojson)
AREAS = {
    "wzw_noord_holland": "NoordHolland",
    "wzw_gelderland": "Gelderland",
    "wzw_drenthe": "Drenthe",
    "wzw_noord_brabant": "NoordBrabant",
    "wzw_zuid_holland": "ZuidHolland",
    "wzw_zeeland": "Zeeland",
    "wzw_hengelo": "Hengelo",
}

# The opening view is fitted to this map size, in CSS px.
VIEW_W, VIEW_H, TILE = 1100, 700, 512


def load_helpers():
    spec = importlib.util.spec_from_file_location("build_wijk_buurt", HERE / "build-wijk-buurt.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def area_bounds(path: Path) -> tuple[float, float, float, float]:
    """Extent of the area (``id`` 2), outer rings only."""
    data = json.loads(path.read_text(encoding="utf-8"))
    xs: list[float] = []
    ys: list[float] = []
    for feature in data["features"]:
        if feature["properties"].get("id") != 2:
            continue
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        for polygon in polygons:
            for x, y, *_ in polygon[0]:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise SystemExit(f"error: {path.name} has no feature with id 2")
    return min(xs), min(ys), max(xs), max(ys)


def opening_view(bounds: tuple[float, float, float, float]) -> tuple[list[float], float]:
    x0, y0, x1, y1 = bounds

    def merc(lat: float) -> float:
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    zx = math.log2(VIEW_W * 360 / (TILE * (x1 - x0)))
    zy = math.log2(VIEW_H * 2 * math.pi / (TILE * (merc(y1) - merc(y0))))
    cy = math.degrees(2 * math.atan(math.exp((merc(y0) + merc(y1)) / 2)) - math.pi / 2)
    zoom = math.floor(min(zx, zy) * 20) / 20
    return [round((x0 + x1) / 2, 5), round(cy, 5)], zoom


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the WZW study-area PMTiles.")
    parser.add_argument("--upload", action="store_true", help="publish the archives to ov-data")
    args = parser.parse_args(argv[1:])

    helpers = load_helpers()
    interpreter = helpers.pmtiles_interpreter()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    built: list[Path] = []

    for variant, name in AREAS.items():
        source = SOURCE_DIR / f"studyarea_WZW{name}.geojson"
        out = OUT_DIR / f"studyarea_WZW{name}.pmtiles"
        center, zoom = opening_view(area_bounds(source))
        if helpers.is_fresh(out, [source]):
            state = "up to date"
        else:
            helpers.run(
                [
                    *interpreter, str(helpers.CONVERT_PMTILES),
                    "--layer", f"studyarea={source}@0-{MAXZOOM}",
                    "--minzoom", "0", "--maxzoom", str(MAXZOOM),
                    "-o", str(out),
                ],
                f"tiling {source.name}",
            )
            state = "built"
        print(f"{variant:<18} {out.name:<36} {out.stat().st_size:>9,} bytes  {state:<10}  center {center}  zoom {zoom}")
        built.append(out)

    if args.upload:
        helpers.upload(built, REMOTE)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
