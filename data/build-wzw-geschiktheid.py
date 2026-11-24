#!/usr/bin/env python3
"""Build the WZW "woningvoorraad / geschiktheid" layers (MapGallery 439, 438, 440).

One national archive, one source layer ``geschiktheid``, shared by every WZW
variant whose MapGallery collection carries the geschiktheid layers. Each 100 m
cell holds the share of its dwellings that is ``nultrede`` (step-free),
``aanpasbaar`` (adaptable) or ``ongeschikt`` (unsuitable), as fractions 0-1, and
``nr_woningen``, the number of dwellings behind those shares. The three map
layers style the same archive on one field each.

Data: ``cbs100m_grid_data/2026/geschiktheid/{m5,m10,m20}.geojson`` (EPSG:3857),
the GeoDMS export. The zoom bands follow
``WoonZorgwijzer_clientside_rendering/scripts/geschiktheid.sh``: m20 z5-8,
m10 z9-10, m5 z11-15.

Steps, each cached:

1. Label: add ``<field>_pct``, the share as a whole percentage, so the click
   popup (``[[ field ]]``, plain substitution) does not print ``0.18181819``.
2. ``convert-geojson-to-pmtiles.py --spec`` -> ``data/pmtiles/woonzorgwijzer/geschiktheid/geschiktheid_2026.pmtiles``.
3. ``--upload`` to ov-data ``pmtiles/woonzorgwijzer/geschiktheid/``.
4. ``--config``: write the three layers and a "Woningvoorraad" > "Geschiktheid"
   nav group into each variant (idempotent), stamping ``?v=`` with ``--stamp``.
   Layer labels come from the variant's MapGallery collection, which spells
   one of them "nultrede" in some provinces and "nultreden" in others.

Usage:
    python data/build-wzw-geschiktheid.py                    # label, build
    python data/build-wzw-geschiktheid.py --upload --config  # publish, then point the config at it
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
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

SOURCE_DIR = bevprog.GEOJSON_ROOT / "geschiktheid"
OUT_DIR = HERE / "pmtiles" / "woonzorgwijzer" / "geschiktheid"
WORK_DIR = OUT_DIR / "work"
NAME = "geschiktheid_2026"
REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/woonzorgwijzer/geschiktheid"
URL = "https://data.derondekaart.nl/pmtiles/woonzorgwijzer/geschiktheid/{name}.pmtiles?v={stamp}"

BANDS = {"m20": (5, 8), "m10": (9, 10), "m5": (11, 15)}
MINZOOM, MAXZOOM = 5, 15
LAYER = "geschiktheid"
FIELDS = ("nultrede", "aanpasbaar", "ongeschikt")

# MapGallery layer per field, in the order the collections list them.
MG_LAYERS = {"nultrede": 439, "aanpasbaar": 438, "ongeschikt": 440}
# Variant -> MapGallery collection. wzw_rivierenland mirrors Gelderland.
VARIANTS = {
    "wzw_noord_holland": 185,
    "wzw_zuid_holland": 199,
    "wzw_zeeland": 192,
    "wzw_noord_brabant": 186,
    "wzw_gelderland": 187,
    "wzw_rivierenland": 187,
}
BOOKMARK = "woningvoorraad"
HEADING = "geschiktheid"

NAV_GROUP = "Woningvoorraad"
NAV_ICON = "home_work"
SUBGROUP = "Geschiktheid"
SUBGROUP_ICON = "accessible"
SUBNAME = "geschiktheid woningvoorraad"


def layer_id(field: str) -> str:
    return f"wzw_geschiktheid_{field}"


def source(res: str) -> Path:
    return SOURCE_DIR / f"{res}.geojson"


def labelled(res: str) -> Path:
    return WORK_DIR / f"geschiktheid_{res}.geojson"


def label(res: str, helpers) -> Path:
    src, out = source(res), labelled(res)
    if helpers.is_fresh(out, [src, Path(__file__)]):
        print(f"  {out.name:<26} up to date")
        return out
    data = json.loads(src.read_text(encoding="utf-8"))
    for feature in data["features"]:
        props = feature["properties"]
        missing = [f for f in (*FIELDS, "nr_woningen") if f not in props]
        if missing:
            raise SystemExit(f"error: {src.name}: feature {props.get('id')} lacks {', '.join(missing)}")
        for field in FIELDS:
            value = props[field]
            props[f"{field}_pct"] = None if value is None else round(value * 100)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {out.name:<26} {len(data['features']):,} features labelled")
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
            "--description", "Geschiktheid woningvoorraad (nultrede, aanpasbaar, ongeschikt), 100 m",
        ],
        out.name,
    )
    spec_path.unlink()
    print(f"  {out.name} built in {time.time() - started:.0f}s ({out.stat().st_size:,} bytes)", flush=True)
    return out


def mapgallery() -> tuple[dict[int, dict], dict[int, dict]]:
    layers = json.loads((bevprog.MAPGALLERY / "MapGallery_layers_export.json").read_text(encoding="utf-8"))
    collections = json.loads((bevprog.MAPGALLERY / "MapGallery_collections_export.json").read_text(encoding="utf-8"))
    return {l["id"]: l for l in layers}, {c["id"]: c for c in collections}


def item_titles(collection: dict) -> dict[int, str]:
    """MapGallery layer id -> item title under the geschiktheid heading."""
    bookmark = next(b for b in collection["bookmarks"] if b["title"] == BOOKMARK)
    titles, heading = {}, None
    for item in bookmark["items"]:
        layer = item.get("layer")
        if not layer:
            heading = item["title"]
            continue
        if heading == HEADING:
            titles[layer["id"]] = item["title"]
    if missing := [i for i in MG_LAYERS.values() if i not in titles]:
        raise SystemExit(f"error: collection {collection['id']}: no {HEADING} item for MapGallery {missing}")
    return titles


def describe(mg: dict) -> str:
    # The last sentence points at "dit document", a link the plain text loses.
    return bevprog.describe(mg.get("metadata")).split(" De exacte definities", 1)[0]


def layer_entry(field: str, mg: dict, stamp: str) -> dict:
    title = field.capitalize()
    return {
        "id": layer_id(field),
        "name": title,
        "subname": SUBNAME,
        "description": describe(mg),
        "source": URL.format(name=NAME, stamp=stamp),
        "format": "pmtiles",
        "sourceLayer": LAYER,
        "geometryType": "polygon",
        "beforeid": "map-layers",
        "style": {"opacity": 0.8},
        "featureinfo": {
            "template": (
                f"<div><b>Geschiktheid woningvoorraad</b> ({html.escape(field)})<table>"
                "<tr><td>Nultrede</td><td>[[ nultrede_pct ]]%</td></tr>"
                "<tr><td>Aanpasbaar</td><td>[[ aanpasbaar_pct ]]%</td></tr>"
                "<tr><td>Ongeschikt</td><td>[[ ongeschikt_pct ]]%</td></tr>"
                "<tr><td>Woningen</td><td>[[ nr_woningen ]]</td></tr>"
                "</table></div>"
            )
        },
        "geostyler": {
            "name": title,
            "rules": [
                {
                    "name": rule["name"].strip(),
                    "filter": rule["filter"],
                    "symbolizers": [{"kind": "Fill", "color": rule["symbolizers"][0]["color"], "outlineWidth": 0}],
                }
                for rule in mg["geostyler"]["rules"]
            ],
        },
    }


def check_rules(mg_layers: dict[int, dict]) -> None:
    """Every MapGallery rule must filter on its own field, or the layer styles the wrong share."""
    for field, mg_id in MG_LAYERS.items():
        for rule in mg_layers[mg_id]["geostyler"]["rules"]:
            if field not in json.dumps(rule["filter"]):
                raise SystemExit(f"error: MapGallery {mg_id} rule {rule['name']!r} does not filter on {field}")


def write_config(variant: str, titles: dict[int, str], entries: dict[str, dict]) -> None:
    folder = bevprog.CONFIGS / variant
    layers_path, nav_path = folder / "layers.json", folder / "navigation.json"
    ids = {layer_id(f) for f in FIELDS}
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    kept = [l for l in layers["layers"] if l["id"] not in ids]
    at = next((i for i, l in enumerate(kept) if l["id"] == "wzw_studiegebied"), len(kept))
    layers["layers"] = kept[:at] + [entries[f] for f in FIELDS] + kept[at:]
    bevprog.write_json(layers_path, layers)

    navigation = [g for g in json.loads(nav_path.read_text(encoding="utf-8")) if g.get("label") != NAV_GROUP]
    group = {
        "label": NAV_GROUP,
        "icon": NAV_ICON,
        "color": bevprog.NAV_COLOR,
        "expanded": False,
        "children": [
            {
                "label": SUBGROUP,
                "icon": SUBGROUP_ICON,
                "color": bevprog.NAV_COLOR,
                "expanded": True,
                "children": [
                    {"id": layer_id(f), "label": titles[MG_LAYERS[f]], "a": False, "b": False} for f in FIELDS
                ],
            }
        ],
    }
    at = next((i for i, g in enumerate(navigation) if g.get("label") in ("Voorzieningen", "Gebiedsindelingen")), len(navigation))
    navigation.insert(at, group)
    bevprog.write_json(nav_path, navigation)
    print(f"  {variant:<18} 3 layers + nav group written")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the WZW geschiktheid PMTiles and config.")
    parser.add_argument("--no-build", action="store_true", help="skip the label and PMTiles steps")
    parser.add_argument("--upload", action="store_true", help="publish the archive to ov-data")
    parser.add_argument("--config", action="store_true", help="write layers.json and navigation.json")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%d"), help="?v= cache stamp in the layer URL")
    args = parser.parse_args(argv[1:])

    mg_layers, collections = mapgallery()
    check_rules(mg_layers)
    titles = {variant: item_titles(collections[cid]) for variant, cid in VARIANTS.items()}

    if not args.no_build or args.upload:
        helpers = bevprog.load_helpers()
        if missing := [res for res in BANDS if not source(res).is_file()]:
            raise SystemExit(f"error: exports missing in {SOURCE_DIR}: {', '.join(missing)}")
        for res in BANDS:
            label(res, helpers)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        archive = build(helpers, helpers.pmtiles_interpreter())
        if args.upload:
            helpers.upload([archive], REMOTE)

    if args.config:
        entries = {f: layer_entry(f, mg_layers[MG_LAYERS[f]], args.stamp) for f in FIELDS}
        for variant in VARIANTS:
            write_config(variant, titles[variant], entries)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
