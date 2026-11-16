#!/usr/bin/env python3
"""Build ``gebiedsindelingen.pmtiles`` from the municipality-level GeoJSON.

The source (``geojson/gebiedsindelingen.geojson``) holds one feature per
gemeente, each carrying the name and id of every region type it belongs to
(provincie, GGD, IZA, jeugdregio, RHO, veilig thuis, woondeal, zorgkantoor).
The region layers are clusters of municipalities drawn as outlines, so each is
DISSOLVED here — tiling the municipalities as-is would show every internal
gemeente border inside a region.

Output: one archive, one source layer per indeling, every feature carrying
``naam`` and ``code``. The ``iza`` layer also carries ``type``: 0 for a
municipality's primary IZA region, 1 for the second region the few
municipalities split between two (``iza2``) — the same split the map gallery's
``regioindelingen_v4`` uses, so a style can colour the overlap separately.

Tiling is delegated to ``convert-geojson-to-pmtiles.py`` (needs the GDAL
Python bindings, like that script).

    python data/build-gebiedsindelingen.py [-o OUT.pmtiles] [--work DIR]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

HERE = Path(__file__).resolve().parent
SRC = HERE / "geojson" / "gebiedsindelingen.geojson"
CONVERT = HERE / "convert-geojson-to-pmtiles.py"

# source layer -> (name field, id field) in the municipality table.
REGIONS = {
    "provincie": ("pr", "pr_id"),
    "ggd": ("ggd", "ggd_id"),
    "jr": ("jr", "jr_id"),
    "rho": ("rho", "rho_id"),
    "vtr": ("vtr", "vtr_id"),
    "wd": ("wd", "wd_id"),
    "zkr": ("zkr", "zkr_id"),
}

MINZOOM, MAXZOOM = 0, 12


# Interior rings smaller than this (m², in EPSG:3857 units) are slivers where
# neighbouring municipality edges do not meet exactly; the union leaves them as
# pinholes inside a region. Real holes (lakes, enclaves) are far larger.
SLIVER_AREA = 10_000


def fill_slivers(geom: BaseGeometry) -> BaseGeometry:
    """Drop interior rings below ``SLIVER_AREA`` from a (multi)polygon."""
    def clean(poly: Polygon) -> Polygon:
        keep = [r for r in poly.interiors if Polygon(r).area >= SLIVER_AREA]
        return Polygon(poly.exterior, keep)

    if isinstance(geom, Polygon):
        return clean(geom)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([clean(p) for p in geom.geoms])
    if isinstance(geom, GeometryCollection):
        polys = [p for g in geom.geoms for p in getattr(g, "geoms", [g])
                 if isinstance(p, Polygon)]
        return MultiPolygon([clean(p) for p in polys])
    return geom


def as_code(value: object) -> str:
    """An id as a clean string: ``10.0`` -> ``"10"``, missing -> ``""``."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def dissolve(gdf: gpd.GeoDataFrame, name: str, code: str) -> gpd.GeoDataFrame:
    """One feature per non-empty ``name`` value, with ``naam`` and ``code``."""
    part = gdf[gdf[name].fillna("").astype(str).str.len() > 0]
    out = part.dissolve(by=name, aggfunc={code: "first"}).reset_index()
    return gpd.GeoDataFrame(
        {"naam": out[name].astype(str), "code": [as_code(v) for v in out[code]]},
        geometry=[fill_slivers(g) for g in out.geometry.make_valid()],
        crs=gdf.crs,
    )


def build_layers(src: Path) -> dict[str, gpd.GeoDataFrame]:
    gdf = gpd.read_file(src)
    gdf["geometry"] = gdf.geometry.make_valid()

    layers: dict[str, gpd.GeoDataFrame] = {
        "gemeente": gpd.GeoDataFrame(
            {"naam": gdf["GM_NAAM"].astype(str), "code": gdf["GM_CODE"].astype(str)},
            geometry=gdf.geometry,
            crs=gdf.crs,
        )
    }
    for layer, (name, code) in REGIONS.items():
        layers[layer] = dissolve(gdf, name, code)

    iza = dissolve(gdf, "iza", "iza_id").assign(type=0)
    if "iza2" in gdf.columns:
        # iza2_id is missing on most rows (absent from those features), so the
        # code falls back to the matching primary region's id by name.
        second = gdf[gdf["iza2"].fillna("").astype(str).str.len() > 0].copy()
        if len(second):
            ids = dict(zip(gdf["iza"].astype(str), (as_code(v) for v in gdf["iza_id"])))
            if "iza2_id" not in second.columns:
                second["iza2_id"] = None
            second["iza2_id"] = [
                as_code(v) or ids.get(str(n), "")
                for v, n in zip(second["iza2_id"], second["iza2"])
            ]
            iza = pd.concat([iza, dissolve(second, "iza2", "iza2_id").assign(type=1)],
                            ignore_index=True)
    layers["iza"] = gpd.GeoDataFrame(iza, geometry="geometry", crs=gdf.crs)
    return layers


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-o", "--output", type=Path, default=HERE / "gebiedsindelingen.pmtiles")
    parser.add_argument("--src", type=Path, default=SRC)
    parser.add_argument("--work", type=Path, default=None,
                        help="Keep the per-layer GeoJSONs here (default: a temp dir)")
    args = parser.parse_args(argv[1:])

    layers = build_layers(args.src)
    with tempfile.TemporaryDirectory() as tmp:
        work = args.work or Path(tmp)
        work.mkdir(parents=True, exist_ok=True)
        flags: list[str] = []
        for layer, gdf in layers.items():
            path = work / f"{layer}.geojson"
            path.unlink(missing_ok=True)
            gdf.to_file(path, driver="GeoJSON")
            flags += ["--layer", f"{layer}={path}"]
            print(f"  {layer:<10} {len(gdf):>4} feature(s)", flush=True)
        command = [sys.executable, str(CONVERT), *flags, "-o", str(args.output),
                   "--minzoom", str(MINZOOM), "--maxzoom", str(MAXZOOM),
                   "--name", "gebiedsindelingen"]
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
