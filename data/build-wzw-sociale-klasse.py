#!/usr/bin/env python3
"""Build the WZW "dominante sociaal economische klasse" layer (MapGallery 435).

One national archive, one source layer ``DSK``, shared by every WZW variant whose
MapGallery collection carries layer 435 (Zuid-Holland, Noord-Brabant, Gelderland,
Zeeland, Drenthe). The cells hold the SCP social class that dominates them, in
12 classes (``data`` 0-11).

Data: GeoDMS item ``/Brondata/CBS_100m_vector_grid/data/Y2026/SDK/dominante_sociale_klasse``
in ``WoonZorgwijzer_clientside_rendering/cfg/stam.dms``, whose ``{m5,m10,m20}/result``
write ``cbs100m_grid_data/2026/dominante_sociale_klasse/_<res>.geojson`` (EPSG:3857).
The zoom bands follow ``scripts/dominante_sociale_klasse_single_tiles.sh``:
m20 z5-8, m10 z9-10, m5 z11-15.

Steps, each cached:

1. GeoDMS for missing exports (``--geodms`` regenerates all three).
2. Label: add ``klasse``, the class name from MapGallery's rule names, so the click
   popup (``[[ klasse ]]``, plain substitution) can show it. Also asserts the
   ``data`` values are exactly 0-11: GeoDMS writes the *index* into the sorted set
   of classes present, which equals the class only when none is missing.
3. ``convert-geojson-to-pmtiles.py --spec`` -> ``data/pmtiles/woonzorgwijzer/dominante_sociale_klasse.pmtiles``.
4. ``--upload`` to ov-data ``pmtiles/woonzorgwijzer/``.
5. ``--config``: write the layer and a "Sociaal economisch" nav group into each
   variant (idempotent), stamping ``?v=`` with ``--stamp`` (default today).

Usage:
    python data/build-wzw-sociale-klasse.py                    # export missing, label, build
    python data/build-wzw-sociale-klasse.py --upload --config  # publish, then point the config at it
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # @dataclass looks its module up there
    spec.loader.exec_module(module)
    return module


bevprog = _load("build_wzw_bevolkingsprognoses", "build-wzw-bevolkingsprognoses.py")

GEODMS_ITEM = "/Brondata/CBS_100m_vector_grid/data/Y2026/SDK/dominante_sociale_klasse/{res}/result"
SOURCE_DIR = bevprog.GEOJSON_ROOT / "dominante_sociale_klasse"
OUT_DIR = HERE / "pmtiles" / "woonzorgwijzer"
WORK_DIR = OUT_DIR / "work"
NAME = "dominante_sociale_klasse"
REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/woonzorgwijzer"
URL = "https://data.derondekaart.nl/pmtiles/woonzorgwijzer/{name}.pmtiles?v={stamp}"

BANDS = {"m20": (5, 8), "m10": (9, 10), "m5": (11, 15)}
MINZOOM, MAXZOOM = 5, 15
LAYER = "DSK"

MG_LAYER = 435
VARIANTS = ["wzw_zuid_holland", "wzw_noord_brabant", "wzw_gelderland", "wzw_zeeland", "wzw_drenthe"]
NAME_FIXES = {"gemend bovenlaag": "gemengd bovenlaag"}

LAYER_ID = "wzw_dominante_sociale_klasse"
TITLE = "Dominante sociaal economische klasse"
NAV_GROUP = "Sociaal economisch"
NAV_ICON = "diversity_3"


def source(res: str) -> Path:
    return SOURCE_DIR / f"_{res}.geojson"


def labelled(res: str) -> Path:
    return WORK_DIR / f"dsk_{res}.geojson"


def mapgallery_rules() -> list[dict]:
    layers = json.loads((bevprog.MAPGALLERY / "MapGallery_layers_export.json").read_text(encoding="utf-8"))
    mg = next(l for l in layers if l["id"] == MG_LAYER)
    rules = []
    for rule in mg["geostyler"]["rules"]:
        name = rule["name"].strip()
        if name in NAME_FIXES:
            print(f"  MapGallery {MG_LAYER}: rule name {name!r} -> {NAME_FIXES[name]!r}")
            name = NAME_FIXES[name]
        rules.append({"name": name, "value": rule["filter"][2], "color": rule["symbolizers"][0]["color"]})
    return rules, mg


def label(res: str, names: dict[int, str], helpers) -> Path:
    src, out = source(res), labelled(res)
    if helpers.is_fresh(out, [src, Path(__file__)]):
        print(f"  {out.name:<20} up to date")
        return out
    data = json.loads(src.read_text(encoding="utf-8"))
    values = {f["properties"]["data"] for f in data["features"]}
    if values != set(names):
        raise SystemExit(
            f"error: {src.name}: data values {sorted(values)} are not the classes {sorted(names)}; "
            "GeoDMS writes the index into the classes present, so a missing class shifts every one after it"
        )
    for feature in data["features"]:
        feature["properties"]["klasse"] = names[feature["properties"]["data"]]
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {out.name:<20} {len(data['features']):,} features labelled")
    return out


def build(helpers, interpreter: list[str]) -> Path:
    out = OUT_DIR / f"{NAME}.pmtiles"
    spec = {LAYER: [{"file": str(labelled(res)), "minzoom": lo, "maxzoom": hi} for res, (lo, hi) in BANDS.items()]}
    inputs = [labelled(res) for res in BANDS]
    if helpers.is_fresh(out, inputs):
        print(f"  {out.name} up to date ({out.stat().st_size:,} bytes)")
        return out
    for leftover in OUT_DIR.glob(f"{out.name}.tmp.mbtiles*"):
        leftover.unlink()
    spec_path = OUT_DIR / f"{NAME}.spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"  {out.name} building …", flush=True)
    started = time.time()
    helpers.run(
        [
            *interpreter, str(helpers.CONVERT_PMTILES),
            "--spec", str(spec_path),
            "-o", str(out),
            "--minzoom", str(MINZOOM), "--maxzoom", str(MAXZOOM),
            "--max-size", str(bevprog.MAX_SIZE), "--max-features", str(bevprog.MAX_FEATURES),
            "--name", NAME,
            "--description", "Dominante sociaal economische klasse (SCP), 100 m",
        ],
        out.name,
    )
    spec_path.unlink()
    print(f"  {out.name} built in {time.time() - started:.0f}s ({out.stat().st_size:,} bytes)", flush=True)
    return out


def layer_entry(rules: list[dict], mg: dict, stamp: str) -> dict:
    return {
        "id": LAYER_ID,
        "name": TITLE,
        "subname": "sociaal economisch",
        "description": bevprog.describe(mg.get("metadata")),
        "source": URL.format(name=NAME, stamp=stamp),
        "format": "pmtiles",
        "sourceLayer": LAYER,
        "geometryType": "polygon",
        "beforeid": "map-layers",
        "style": {"opacity": 0.8},
        "featureinfo": {
            "template": f"<div><b>{html.escape(TITLE)}</b><table><tr><td>Klasse</td><td>[[ klasse ]]</td></tr></table></div>"
        },
        "geostyler": {
            "name": TITLE,
            "rules": [
                {
                    "name": rule["name"],
                    "filter": ["==", "data", rule["value"]],
                    "symbolizers": [{"kind": "Fill", "color": rule["color"], "outlineWidth": 0}],
                }
                for rule in rules
            ],
        },
    }


def write_config(variant: str, entry: dict) -> None:
    folder = bevprog.CONFIGS / variant
    layers_path, nav_path = folder / "layers.json", folder / "navigation.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    kept = [l for l in layers["layers"] if l["id"] != LAYER_ID]
    at = next((i for i, l in enumerate(kept) if l["id"] == "wzw_studiegebied"), len(kept))
    layers["layers"] = kept[:at] + [entry] + kept[at:]
    bevprog.write_json(layers_path, layers)

    navigation = [g for g in json.loads(nav_path.read_text(encoding="utf-8")) if g.get("label") != NAV_GROUP]
    group = {
        "label": NAV_GROUP,
        "icon": NAV_ICON,
        "color": bevprog.NAV_COLOR,
        "expanded": False,
        "children": [{"id": LAYER_ID, "label": TITLE, "a": False, "b": False}],
    }
    at = next((i for i, g in enumerate(navigation) if g.get("label") == "Gebiedsindelingen"), len(navigation))
    navigation.insert(at, group)
    bevprog.write_json(nav_path, navigation)
    print(f"  {variant:<18} layer + nav group written")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the WZW dominante sociale klasse PMTiles and config.")
    parser.add_argument("--geodms", action="store_true", help="regenerate all three GeoDMS exports")
    parser.add_argument("--geodms-exe", type=Path, default=bevprog.GEODMS_EXE)
    parser.add_argument("--no-build", action="store_true", help="skip GeoDMS, label and PMTiles steps")
    parser.add_argument("--upload", action="store_true", help="publish the archive to ov-data")
    parser.add_argument("--config", action="store_true", help="write layers.json and navigation.json")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%d"), help="?v= cache stamp in the layer URL")
    args = parser.parse_args(argv[1:])

    rules, mg = mapgallery_rules()
    names = {rule["value"]: rule["name"] for rule in rules}

    if not args.no_build or args.upload:
        helpers = bevprog.load_helpers()
        todo = list(BANDS) if args.geodms else [res for res in BANDS if not source(res).is_file()]
        for res in todo:
            bevprog.run_geodms_item(GEODMS_ITEM.format(res=res), f"dsk {res}", args.geodms_exe)
        if missing := [res for res in BANDS if not source(res).is_file()]:
            raise SystemExit(f"error: exports still missing for {', '.join(missing)}")
        for res in BANDS:
            label(res, names, helpers)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        archive = build(helpers, helpers.pmtiles_interpreter())
        if args.upload:
            helpers.upload([archive], REMOTE)

    if args.config:
        entry = layer_entry(rules, mg, args.stamp)
        for variant in VARIANTS:
            write_config(variant, entry)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
