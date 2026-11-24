#!/usr/bin/env python3
"""Build the woonzorglimburg "reliëf" layer: terrain slope zoomed out, road slope zoomed in.

One PMTiles archive with two source layers, shown as one composite layer:

* ``vlak`` (z5-12) - the classified terrain slope of ``special_layers/AHN2Stijgingspercentage.py``,
  30 m cells, polygons.
* ``weg`` (z13-14, overzoomed beyond) - the along-road slope of
  ``special_layers/AHN_OSM_2StijgingspercentageWeg.py``, line pieces of ~25 m.

Both carry ``klasse`` (0 flat, 1 <2%, 2 <4%, 3 <8%, 4 <12%, 5 >=12%, 255 no data) and
``omschrijving``, the popup text, so one composite legend and one popup template
serve both zoom bands.

Vlak source: the AHN script's ``stijgingspercentage_lb.tif`` (``--tif``). That file
is an 80-minute WCS run and is not kept, so by default the published comparison
COG is fetched instead. The COG is the same classes, resampled to 9.55 m in
EPSG:3857; it is mode-resampled back onto the 30 m RD grid before vectorising,
which keeps the polygon count at what the source grid gives. ``GRID_OFFSET`` is
that grid's origin modulo 30 m, found by testing which alignment makes each 30 m
cell most uniform in the COG.

Steps, each cached:

1. Vlak raster (``--tif`` or the COG) -> 30 m RD tif -> ``convert-tif-to-geojson.py``.
2. Label vlak and weg (``klasse``, ``omschrijving``; weg keeps name/fclass/stijging_pct).
3. ``convert-geojson-to-pmtiles.py --spec`` -> ``data/pmtiles/woonzorglimburg/stijgingspercentage_2026.pmtiles``.
4. ``--upload`` the archive to wzl-data ``pmtiles/``. The metainfo is the spreadsheet
   row ``relief`` in ``meta/woonzorglimburg/metadata.xlsx``, published by
   ``meta/genereer_html.py``.
5. ``--config``: replace the two old layers with the composite in woonzorglimburg
   (versie_1_0) and woonzorglimburg_ontwikkel, and flatten Omgeving's navigation (idempotent).

Usage:
    python data/build-wzl-relief.py                    # build
    python data/build-wzl-relief.py --upload --config  # publish, then point the config at it
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # @dataclass looks its module up there
    spec.loader.exec_module(module)
    return module


bevprog = _load("build_wzw_bevolkingsprognoses", "build-wzw-bevolkingsprognoses.py")

SPECIAL = HERE / "special_layers"
WORK = SPECIAL / "work"
COG_REMOTE = "wzl-data:/var/www/woonzorglimburg_data/cog/comparison/stijgingspercentage_lb_2026.cog.tif"
COG_LOCAL = WORK / "stijgingspercentage_lb_2026.cog.tif"
WEG_SOURCE = SPECIAL / "stijgingspercentage_weg_limburg.geojson"
VLAK_TIF = WORK / "relief_vlak_30m.tif"
VLAK_RAW = WORK / "relief_vlak_raw.geojson"
VLAK = WORK / "relief_vlak.geojson"
WEG = WORK / "relief_weg.geojson"

CELL = 30.0
GRID_OFFSET = (5.0, 0.0)  # RD x, y of the 30 m grid's origin, modulo CELL
NODATA = 255

NAME = "stijgingspercentage_2026"
OUT_DIR = HERE / "pmtiles" / "woonzorglimburg"
META_INDEX = HERE / "meta" / "woonzorglimburg" / "resultaten" / "index.json"
META_ID = "relief"  # the layer's row in metadata.xlsx
REMOTE_PMTILES = "wzl-data:/var/www/woonzorglimburg_data/pmtiles"
URL = "https://data.woonzorglimburg.nl/pmtiles/{name}.pmtiles?v={stamp}"
META_URL = "https://data.woonzorglimburg.nl/meta/{name}_{part}.html"
META_PARTS = ("toelichting", "bronnen", "aannames_en_onzekerheden")

CUTOVER = 13  # vlak below, weg from here
BANDS = {"vlak": (VLAK, 5, CUTOVER - 1), "weg": (WEG, CUTOVER, 14)}

CONFIGS = REPO / "configs"
# Folders holding a layers.json + navigation.json: the public project's one
# variant, and the separate (basic-auth) staging project.
VARIANTS = ["woonzorglimburg/versie_1_0", "woonzorglimburg_ontwikkel"]
OLD_VLAK, OLD_WEG = "stijgingspercentage_lb_2026", "stijgingspercentage_weg_limburg"
LAYER_ID = NAME
RULE_3_30_300 = "bomen_rule_3_30_300_classified_2026"

CLASSES = {
    1: ("0% tot 2%", "#99d594"),
    2: ("2% tot 4%", "#e6f598"),
    3: ("4% tot 8%", "#fee08b"),
    4: ("8% tot 12%", "#fc8d59"),
    5: ("12% of meer", "#d53e4f"),
}
NO_DATA = ("geen gegevens", "#bdbdbd")
CLASS_TEXT = {0: "vlak (0%)", **{k: v[0] for k, v in CLASSES.items()}, NODATA: NO_DATA[0]}
LINE_WIDTH = ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 2, 17, 5]


# --- build -------------------------------------------------------------------


def fetch_cog() -> Path:
    if COG_LOCAL.is_file():
        return COG_LOCAL
    WORK.mkdir(parents=True, exist_ok=True)
    scp = bevprog.load_helpers().resolve_ssh_tool("scp")
    print(f"  fetching {COG_REMOTE}")
    if subprocess.run([scp, "-o", "BatchMode=yes", COG_REMOTE, str(COG_LOCAL)], check=False).returncode:
        raise SystemExit("error: could not fetch the vlak COG; pass --tif")
    return COG_LOCAL


def regrid(source: Path) -> Path:
    """Mode-resample the classified raster onto the 30 m RD grid."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject, transform_bounds

    if bevprog.load_helpers().is_fresh(VLAK_TIF, [source, Path(__file__)]):
        print(f"  {VLAK_TIF.name:<24} up to date")
        return VLAK_TIF
    with rasterio.open(source) as src:
        left, bottom, right, top = transform_bounds(src.crs, "EPSG:28992", *src.bounds)
        ox, oy = GRID_OFFSET
        left = np.floor((left - ox) / CELL) * CELL + ox
        top = np.ceil((top - oy) / CELL) * CELL + oy
        width = int(np.ceil((right - left) / CELL))
        height = int(np.ceil((top - bottom) / CELL))
        out = np.full((height, width), NODATA, dtype="uint8")
        transform = from_origin(left, top, CELL, CELL)
        reproject(
            rasterio.band(src, 1), out,
            src_nodata=src.nodata if src.nodata is not None else NODATA,
            dst_transform=transform, dst_crs="EPSG:28992", dst_nodata=NODATA,
            resampling=Resampling.mode,
        )
    profile = {
        "driver": "GTiff", "dtype": "uint8", "count": 1, "width": width, "height": height,
        "crs": "EPSG:28992", "transform": transform, "nodata": NODATA,
        "compress": "DEFLATE", "tiled": True,
    }
    with rasterio.open(VLAK_TIF, "w", **profile) as dst:
        dst.write(out, 1)
    print(f"  {VLAK_TIF.name:<24} {width} x {height} @ {CELL:.0f} m")
    return VLAK_TIF


def vectorise(tif: Path, helpers) -> Path:
    if helpers.is_fresh(VLAK_RAW, [tif]):
        print(f"  {VLAK_RAW.name:<24} up to date")
        return VLAK_RAW
    print(f"  {VLAK_RAW.name:<24} vectorising …", flush=True)
    helpers.run([sys.executable, str(HERE / "convert-tif-to-geojson.py"), str(tif), str(VLAK_RAW)], VLAK_RAW.name)
    return VLAK_RAW


def label_vlak(raw: Path, helpers) -> None:
    if helpers.is_fresh(VLAK, [raw, Path(__file__)]):
        print(f"  {VLAK.name:<24} up to date")
        return
    data = json.loads(raw.read_text(encoding="utf-8"))
    for feature in data["features"]:
        props = feature["properties"]
        klasse = int(props.pop("class"))
        feature["properties"] = {"klasse": klasse, "omschrijving": f"terrein {CLASS_TEXT.get(klasse, klasse)}"}
    VLAK.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {VLAK.name:<24} {len(data['features']):,} polygons")


def weg_text(name, fclass, pct, klasse) -> str:
    road = name if isinstance(name, str) and name.strip() else (fclass or "weg")
    if klasse == NODATA or pct is None or (isinstance(pct, float) and np.isnan(pct)):
        return f"{road}: {NO_DATA[0]}"
    percent = f"{float(pct):.1f}".replace(".", ",")
    return f"{road}: {percent}% ({CLASS_TEXT.get(int(klasse), klasse)})"


def label_weg(helpers) -> None:
    import pyogrio

    if helpers.is_fresh(WEG, [WEG_SOURCE, Path(__file__)]):
        print(f"  {WEG.name:<24} up to date")
        return
    print(f"  {WEG.name:<24} labelling …", flush=True)
    roads = pyogrio.read_dataframe(WEG_SOURCE, columns=["fclass", "name", "stijging_pct", "klasse"])
    roads["omschrijving"] = [
        weg_text(n, f, p, k)
        for n, f, p, k in zip(roads["name"], roads["fclass"], roads["stijging_pct"], roads["klasse"])
    ]
    if WEG.exists():
        WEG.unlink()
    pyogrio.write_dataframe(roads, WEG, driver="GeoJSON", layer_options={"COORDINATE_PRECISION": 7, "RFC7946": "YES"})
    print(f"  {WEG.name:<24} {len(roads):,} road pieces")


def build(helpers) -> Path:
    out = OUT_DIR / f"{NAME}.pmtiles"
    inputs = [path for path, _, _ in BANDS.values()]
    if helpers.is_fresh(out, inputs):
        print(f"  {out.name} up to date ({out.stat().st_size:,} bytes)")
        return out
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for leftover in OUT_DIR.glob(f"{out.name}.tmp.mbtiles*"):
        leftover.unlink()
    spec = {layer: [{"file": str(path), "minzoom": lo, "maxzoom": hi}] for layer, (path, lo, hi) in BANDS.items()}
    spec_path = OUT_DIR / f"{NAME}.spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"  {out.name} building …", flush=True)
    started = time.time()
    helpers.run(
        [
            *helpers.pmtiles_interpreter(), str(helpers.CONVERT_PMTILES),
            "--spec", str(spec_path), "-o", str(out),
            "--minzoom", "5", "--maxzoom", "14",
            "--max-size", str(bevprog.MAX_SIZE), "--max-features", str(bevprog.MAX_FEATURES),
            "--name", NAME,
            "--description", "Stijgingspercentage (AHN4): terrein tot zoom 12, wegen vanaf zoom 13, Limburg",
        ],
        out.name,
    )
    spec_path.unlink()
    print(f"  {out.name} built in {time.time() - started:.0f}s ({out.stat().st_size:,} bytes)", flush=True)
    return out


# --- config ------------------------------------------------------------------


def fill_rules(field: str = "klasse") -> list[dict]:
    return [
        {
            "name": name,
            "filter": ["==", field, value],
            "symbolizers": [{"kind": "Fill", "color": color, "outlineColor": color, "outlineWidth": 0}],
        }
        for value, (name, color) in CLASSES.items()
    ]


def line_rule(name: str, value: int, color: str) -> dict:
    return {
        "name": name,
        "filter": ["==", "klasse", value],
        "symbolizers": [{"kind": "Line", "color": color, "width": 2, "paint": {"line-width": LINE_WIDTH}}],
    }


def meta() -> dict:
    """The tabs genereer_html.py wrote for the ``relief`` row (all three if not generated yet)."""
    index = json.loads(META_INDEX.read_text(encoding="utf-8")) if META_INDEX.is_file() else None
    return {
        part: META_URL.format(name=META_ID, part=part)
        for part in META_PARTS
        if index is None or META_ID in index.get(part, [])
    }


def layer_entry(stamp: str) -> dict:
    source = URL.format(name=NAME, stamp=stamp)
    legend = fill_rules()
    name, color = NO_DATA
    legend.append({
        "name": name,
        "filter": ["==", "klasse", NODATA],
        "symbolizers": [{"kind": "Fill", "color": color, "outlineColor": color, "outlineWidth": 0}],
    })
    return {
        "id": LAYER_ID,
        "name": "Stijgingspercentage",
        "subname": "reliëf",
        "meta": meta(),
        "format": "composite",
        "geometryType": "polygon",
        "geostyler": {"name": "Stijgingspercentage", "rules": legend},
        "featureinfo": {"template": "<div><b>Stijgingspercentage</b><br>[[ omschrijving ]]</div>"},
        "layers": [
            {
                "source": source,
                "format": "pmtiles",
                "sourceLayer": "vlak",
                "geometryType": "polygon",
                "maxzoom": CUTOVER,
                "style": {"opacity": 0.8},
                "geostyler": {"name": "Stijgingspercentage terrein", "rules": fill_rules()},
            },
            {
                "source": source,
                "format": "pmtiles",
                "sourceLayer": "weg",
                "geometryType": "line",
                "minzoom": CUTOVER,
                "beforeid": "foreground-layers",
                "style": {"opacity": 0.9},
                "geostyler": {
                    "name": "Stijgingspercentage weg",
                    "rules": [line_rule(n, v, c) for v, (n, c) in CLASSES.items()] + [line_rule(name, NODATA, color)],
                },
            },
        ],
    }


def flatten_omgeving(navigation: list[dict]) -> None:
    omgeving = next(g for g in navigation if g.get("label") == "Omgeving")
    children = []
    for child in omgeving["children"]:
        label = child.get("label", "")
        if label == "3-30-300 vuistregel" and "children" in child:
            item = next(c for c in child["children"] if c.get("id") == RULE_3_30_300)
            children.append(item)
        elif label == "reliëf" and "children" in child:
            children.append({"id": LAYER_ID, "color": "#7A5C3E", "label": "reliëf", "a": False, "b": False})
        else:
            children.append(child)
    omgeving["children"] = children


def write_config(variant: str, entry: dict) -> None:
    folder = CONFIGS / variant
    layers_path, nav_path = folder / "layers.json", folder / "navigation.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    items = layers["layers"]
    ids = [l["id"] for l in items]
    at = next((ids.index(i) for i in (LAYER_ID, OLD_VLAK) if i in ids), len(items))
    kept_before = [l for l in items[:at] if l["id"] not in (LAYER_ID, OLD_VLAK, OLD_WEG)]
    kept_after = [l for l in items[at:] if l["id"] not in (LAYER_ID, OLD_VLAK, OLD_WEG)]
    layers["layers"] = kept_before + [copy.deepcopy(entry)] + kept_after
    bevprog.write_json(layers_path, layers)

    navigation = json.loads(nav_path.read_text(encoding="utf-8"))
    flatten_omgeving(navigation)
    bevprog.write_json(nav_path, navigation)
    print(f"  {variant:<10} layer + navigation written")


# --- main --------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the woonzorglimburg reliëf PMTiles and config.")
    parser.add_argument("--tif", type=Path, help="the AHN script's classified tif (default: the published COG)")
    parser.add_argument("--no-build", action="store_true", help="skip the build steps")
    parser.add_argument("--upload", action="store_true", help="publish the archive to wzl-data")
    parser.add_argument("--config", action="store_true", help="write layers.json and navigation.json")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%d"), help="?v= cache stamp in the layer URL")
    args = parser.parse_args(argv[1:])

    if not args.no_build or args.upload:
        helpers = bevprog.load_helpers()
        WORK.mkdir(parents=True, exist_ok=True)
        tif = regrid(args.tif or fetch_cog())
        label_vlak(vectorise(tif, helpers), helpers)
        label_weg(helpers)
        archive = build(helpers)
        if args.upload:
            helpers.upload([archive], REMOTE_PMTILES)

    if args.config:
        entry = layer_entry(args.stamp)
        for variant in VARIANTS:
            write_config(variant, entry)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
