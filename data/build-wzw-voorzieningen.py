#!/usr/bin/env python3
"""Build the WZW voorzieningen layers: locaties (points) and loopafstanden (grid).

Mirrors each variant's MapGallery "voorzieningen" bookmark: a "locaties" part
(point icons, one MapGallery layer per voorziening type, all filtering one
source on ``type``) and a "loopafstanden" part (100 m cells classed by walking
distance in metres, plus two "triple A" combinations).

Data, from ``WoonZorgwijzer_clientside_rendering/cfg/stam.dms``:

* ``…/Y2026/voorzieningen/vrz_locaties/m5`` -> ``2026/vrz_locaties/m5.geojson``
  (EPSG:3857 points; ``type`` codes from ``brondata/voorziening.dms``: ov 0, then
  ``base_types`` from 1, then the extra types from 25).
* ``…/Y2026/voorzieningen/vrz_loopafstanden/grid_level/results/<res>/data_at_res``
  -> ``2026/loopafstanden/<res>.geojson``. This reruns the walking-network
  analysis and takes a long time.

Zoom bands follow ``scripts/vrz_locaties.sh`` (m5 at every zoom) and
``scripts/vrz_loopafstanden.sh`` (m20 z5-8, m10 z9-10, m5 z11-15).

Steps, each cached:

1. GeoDMS for missing exports (``--geodms`` regenerates all four).
2. Locaties: keep the types some variant uses, repair Latin-1 names, write a
   work copy. Loopafstanden: scan the fields' ranges; a negative minimum (an
   "unknown" distance) gets a ``>= 0`` lower bound on the first class, so those
   cells are not painted as close by.
3. ``convert-geojson-to-pmtiles.py`` -> ``data/pmtiles/woonzorgwijzer/voorzieningen/``.
4. ``--upload`` to ov-data ``pmtiles/woonzorgwijzer/voorzieningen/``.
5. ``--config``: the layers and a "Voorzieningen" nav group per variant
   (idempotent), ``?v=`` stamped with ``--stamp`` (default today).

Usage:
    python data/build-wzw-voorzieningen.py --geodms           # regenerate exports, build
    python data/build-wzw-voorzieningen.py --upload --config  # publish, rewrite config
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


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # @dataclass looks its module up there
    spec.loader.exec_module(module)
    return module


bevprog = _load("build_wzw_bevolkingsprognoses", "build-wzw-bevolkingsprognoses.py")

GEODMS_ROOT = "/Brondata/CBS_100m_vector_grid/data/Y2026/voorzieningen"
LOC_ITEM = f"{GEODMS_ROOT}/vrz_locaties/m5"
LOOP_ITEM = GEODMS_ROOT + "/vrz_loopafstanden/grid_level/results/{res}/vector_grid/data_at_res"
LOC_SOURCE = bevprog.GEOJSON_ROOT / "vrz_locaties" / "m5.geojson"
LOOP_DIR = bevprog.GEOJSON_ROOT / "loopafstanden"

OUT_DIR = HERE / "pmtiles" / "woonzorgwijzer" / "voorzieningen"
WORK_DIR = OUT_DIR / "work"
REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/woonzorgwijzer/voorzieningen"
URL = "https://data.derondekaart.nl/pmtiles/woonzorgwijzer/voorzieningen/{name}.pmtiles?v={stamp}"

LOC_NAME, LOC_LAYER = "vrz_locaties", "vrz_locaties"
LOOP_NAME, LOOP_LAYER = "vrz_loopafstanden", "loopafstanden"
LOOP_BANDS = {"m20": (5, 8), "m10": (9, 10), "m5": (11, 15)}
MINZOOM, MAXZOOM = 5, 15
LOC_FIELDS = ("naam", "type", "postcode", "huisnummer", "plaats")

VARIANTS = {
    "wzw_noord_holland": 185,
    "wzw_zuid_holland": 199,
    "wzw_zeeland": 192,
    "wzw_noord_brabant": 186,
    "wzw_gelderland": 187,
    "wzw_drenthe": 193,
}
# Not in GeoDMS (DUO onderwijs, ZH only): left out on request.
SKIP_LAYERS = {847, 848, 849}

ICON_DIR = "/icons/wzw"
ICON_SIZES = {"bushalte_shadow": 20, "red_dark_koffie": 20, "grey_koffie": 20}  # others 22
# The three distances behind each triple A layer, for its popup.
TRIPLE_A = {
    "aaa_apo_huis_sup": ("apotheek", "huisarts", "supermarkt"),
    "aaa_ov_huis_sup": ("ov", "huisarts", "supermarkt"),
}
DISTANCE_LABEL = {"ov": "ov-halte"}

NAV_GROUP = "Voorzieningen"
SUBGROUPS = {"locaties": ("Locaties", "location_on"), "loopafstanden": ("Loopafstanden", "directions_walk")}


# --- MapGallery --------------------------------------------------------------

def bookmark_items(collection_id: int, mg_layers: dict[int, dict]):
    """(heading, MapGallery layer, item title) for the voorzieningen bookmark."""
    collections = json.loads((bevprog.MAPGALLERY / "MapGallery_collections_export.json").read_text(encoding="utf-8"))
    collection = next(c for c in collections if c["id"] == collection_id)
    bookmark = next(b for b in collection["bookmarks"] if b["title"] == "voorzieningen")
    heading = None
    for item in bookmark["items"]:
        layer = item.get("layer")
        if not layer:
            heading = item["title"].strip().lower()
            continue
        if layer["id"] in SKIP_LAYERS:
            continue
        yield heading, mg_layers[layer["id"]], item["title"].strip()


def all_items():
    mg_layers = {l["id"]: l for l in json.loads((bevprog.MAPGALLERY / "MapGallery_layers_export.json").read_text(encoding="utf-8"))}
    return {variant: list(bookmark_items(cid, mg_layers)) for variant, cid in VARIANTS.items()}


def is_locatie(mg: dict) -> bool:
    return mg["layername"].startswith("vrz_locaties")


def rule_field(rule: dict) -> str:
    flt = rule["filter"]
    return flt[1][1] if flt[0] == "&&" else flt[1]


# --- data ----------------------------------------------------------------------

def prepare_locaties(types: set[int], helpers) -> Path:
    out = WORK_DIR / "vrz_locaties_m5.geojson"
    if helpers.is_fresh(out, [LOC_SOURCE, Path(__file__)]):
        print(f"  {out.name:<28} up to date")
        return out
    raw = LOC_SOURCE.read_bytes()
    try:
        text, repaired = raw.decode("utf-8"), 0
    except UnicodeDecodeError:
        # Mixed: decode valid UTF-8 runs as such and the rest as cp1252.
        text = raw.decode("utf-8", errors="surrogateescape")
        bad = re.findall(r"[\udc80-\udcff]+", text)
        repaired = len(bad)
        text = re.sub(r"[\udc80-\udcff]+", lambda m: bytes(ord(c) - 0xDC00 for c in m.group()).decode("cp1252", errors="replace"), text)
    data = json.loads(text)
    total = len(data["features"])
    present = {f["properties"].get("type") for f in data["features"]}
    if missing := sorted(types - present):
        raise SystemExit(f"error: {LOC_SOURCE.name}: no features of type {missing}")
    kept = []
    for feature in data["features"]:
        props = feature["properties"]
        if props.get("type") in types and feature.get("geometry"):
            feature["properties"] = {k: props[k] for k in LOC_FIELDS if props.get(k) not in (None, "")}
            kept.append(feature)
    data["features"] = kept
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    note = f", {repaired} Latin-1 run(s) repaired" if repaired else ""
    print(f"  {out.name:<28} {len(kept):,} of {total:,} kept (types {sorted(types)}){note}")
    return out


def loop_stats(fields: set[str], helpers) -> dict[str, list[int]]:
    """[min, max] per field over all three resolutions, cached."""
    out = WORK_DIR / "loopafstanden_stats.json"
    sources = [LOOP_DIR / f"{res}.geojson" for res in LOOP_BANDS]
    if helpers.is_fresh(out, sources + [Path(__file__)]):
        stats = json.loads(out.read_text(encoding="utf-8"))
        if fields <= set(stats):
            return stats
    stats: dict[str, list[int]] = {}
    pattern = re.compile(r'"properties":\s*(\{[^}]*\})')
    for src in sources:
        print(f"  scanning {src.name} …", flush=True)
        with src.open(encoding="utf-8") as handle:
            for line in handle:
                m = pattern.search(line)
                if not m:
                    continue
                for key, value in json.loads(m.group(1)).items():
                    if isinstance(value, (int, float)):
                        lo_hi = stats.setdefault(key, [value, value])
                        lo_hi[0], lo_hi[1] = min(lo_hi[0], value), max(lo_hi[1], value)
    if missing := sorted(fields - set(stats)):
        raise SystemExit(f"error: loopafstanden exports have no field(s) {missing}")
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(stats, indent=1), encoding="utf-8")
    return stats


def convert(name: str, spec: dict, inputs: list[Path], description: str, helpers, interpreter) -> Path:
    out = OUT_DIR / f"{name}.pmtiles"
    if helpers.is_fresh(out, inputs):
        print(f"  {out.name:<28} up to date ({out.stat().st_size:,} bytes)")
        return out
    for leftover in OUT_DIR.glob(f"{out.name}.tmp.mbtiles*"):
        leftover.unlink()
    spec_path = OUT_DIR / f"{name}.spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    print(f"  {out.name:<28} building …", flush=True)
    started = time.time()
    helpers.run(
        [
            *interpreter, str(helpers.CONVERT_PMTILES),
            "--spec", str(spec_path), "-o", str(out),
            "--minzoom", str(MINZOOM), "--maxzoom", str(MAXZOOM),
            "--max-size", str(bevprog.MAX_SIZE), "--max-features", str(bevprog.MAX_FEATURES),
            "--name", name, "--description", description,
        ],
        out.name,
    )
    spec_path.unlink()
    print(f"  {out.name:<28} built in {time.time() - started:.0f}s ({out.stat().st_size:,} bytes)", flush=True)
    return out


# --- config --------------------------------------------------------------------

def icon(url: str) -> dict:
    stem = Path(url).stem
    size = ICON_SIZES.get(stem, 22)
    return {"kind": "Icon", "image": f"{ICON_DIR}/{stem}.png", "width": size, "height": size, "size": size}


def locatie_entry(mg: dict, title: str, stamp: str) -> dict:
    rule = mg["geostyler"]["rules"][0]
    code = rule["filter"][2]
    name = title[0].upper() + title[1:]
    return {
        "id": f"wzw_vrz_{re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')}",
        "name": name,
        "subname": "locaties",
        "description": bevprog.describe(mg.get("metadata")),
        "source": URL.format(name=LOC_NAME, stamp=stamp),
        "format": "pmtiles",
        "sourceLayer": LOC_LAYER,
        "geometryType": "point",
        "beforeid": "map-layers",
        "featureinfo": {
            "template": f"<div><b>{html.escape(name)}</b><BR>Naam: <b>[[ naam ]]</b><BR>Adres: <b>[[ postcode ]] [[ huisnummer ]]</b><BR>Plaats: <b>[[ plaats ]]</b></div>"
        },
        "geostyler": {
            "name": name,
            "rules": [{"name": rule["name"].strip(), "filter": ["==", "type", code], "symbolizers": [icon(rule["symbolizers"][0]["image"])]}],
        },
    }


def loop_entry(mg: dict, title: str, stats: dict, stamp: str) -> dict:
    rules = mg["geostyler"]["rules"]
    field = rule_field(rules[0])
    name = title[0].upper() + title[1:]
    styled = []
    for i, rule in enumerate(rules):
        flt = rule["filter"]
        # An "unknown" distance is negative; keep it out of the closest class.
        if i == 0 and field not in TRIPLE_A and flt[0] == "<" and stats[field][0] < 0:
            flt = ["&&", [">=", field, 0], flt]
        styled.append({"name": rule["name"].strip(), "filter": flt, "symbolizers": [{"kind": "Fill", "color": rule["symbolizers"][0]["color"], "outlineWidth": 0}]})
    if field in TRIPLE_A:
        rows = "".join(f"<tr><td>{DISTANCE_LABEL.get(f, f)}</td><td>[[ {f} ]] m</td></tr>" for f in TRIPLE_A[field])
        body = f"<table>{rows}</table>"
    else:
        body = f"Loopafstand tot dichtstbijzijnde {DISTANCE_LABEL.get(field, field)}: <b>[[ {field} ]] meter</b>"
    return {
        "id": f"wzw_vrz_loop_{field}",
        "name": name,
        "subname": "loopafstanden",
        "description": bevprog.describe(mg.get("metadata")),
        "source": URL.format(name=LOOP_NAME, stamp=stamp),
        "format": "pmtiles",
        "sourceLayer": LOOP_LAYER,
        "geometryType": "polygon",
        "beforeid": "map-layers",
        "style": {"opacity": 0.8},
        "featureinfo": {"template": f"<div><b>{html.escape(name)}</b><BR>{body}</div>"},
        "geostyler": {"name": name, "rules": styled},
    }


def write_config(variant: str, items, stats: dict, stamp: str) -> None:
    entries, groups = [], {}
    for heading, mg, title in items:
        entry = locatie_entry(mg, title, stamp) if is_locatie(mg) else loop_entry(mg, title, stats, stamp)
        if any(e["id"] == entry["id"] for e in entries):
            raise SystemExit(f"error: {variant}: duplicate layer id {entry['id']}")
        entries.append(entry)
        label, icon_name = SUBGROUPS[heading]
        group = groups.setdefault(heading, {"label": label, "icon": icon_name, "color": bevprog.NAV_COLOR, "expanded": not groups, "children": []})
        group["children"].append({"id": entry["id"], "label": entry["name"], "a": False, "b": False})

    folder = bevprog.CONFIGS / variant
    layers_path, nav_path = folder / "layers.json", folder / "navigation.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    kept = [l for l in layers["layers"] if not l["id"].startswith("wzw_vrz_")]
    at = next((i for i, l in enumerate(kept) if l["id"] == "wzw_studiegebied"), len(kept))
    layers["layers"] = kept[:at] + entries + kept[at:]
    bevprog.write_json(layers_path, layers)

    navigation = [g for g in json.loads(nav_path.read_text(encoding="utf-8")) if g.get("label") != NAV_GROUP]
    group = {"label": NAV_GROUP, "icon": "storefront", "color": bevprog.NAV_COLOR, "expanded": False, "children": list(groups.values())}
    at = next((i for i, g in enumerate(navigation) if g.get("label") == "Gebiedsindelingen"), len(navigation))
    navigation.insert(at, group)
    bevprog.write_json(nav_path, navigation)
    print(f"  {variant:<18} {len(entries)} layers -> layers.json, navigation.json")


# --- main ----------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the WZW voorzieningen PMTiles and config.")
    parser.add_argument("--geodms", action="store_true", help="regenerate all four GeoDMS exports")
    parser.add_argument("--geodms-exe", type=Path, default=bevprog.GEODMS_EXE)
    parser.add_argument("--no-build", action="store_true", help="skip GeoDMS, preparation and PMTiles")
    parser.add_argument("--upload", action="store_true", help="publish the archives to ov-data")
    parser.add_argument("--config", action="store_true", help="write layers.json and navigation.json")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%d"), help="?v= cache stamp in the layer URLs")
    args = parser.parse_args(argv[1:])

    items = all_items()
    types = {mg["geostyler"]["rules"][0]["filter"][2] for its in items.values() for _, mg, _ in its if is_locatie(mg)}
    loop_fields = {rule_field(r) for its in items.values() for _, mg, _ in its if not is_locatie(mg) for r in mg["geostyler"]["rules"]}
    loop_fields |= {f for fs in TRIPLE_A.values() for f in fs}

    helpers = bevprog.load_helpers()
    if not args.no_build or args.upload:
        jobs = [(LOC_ITEM, LOC_SOURCE, "vrz_locaties m5")] + [
            (LOOP_ITEM.format(res=res), LOOP_DIR / f"{res}.geojson", f"loopafstanden {res}") for res in LOOP_BANDS
        ]
        for item, out, what in jobs:
            if args.geodms or not out.is_file():
                bevprog.run_geodms_item(item, what, args.geodms_exe)
        if missing := [str(out) for _, out, _ in jobs if not out.is_file()]:
            raise SystemExit(f"error: exports still missing: {missing}")

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        loc = prepare_locaties(types, helpers)
        stats = loop_stats(loop_fields, helpers)
        for field in sorted(loop_fields):
            print(f"    {field:<20} {stats[field][0]:>8} .. {stats[field][1]}")
        interpreter = helpers.pmtiles_interpreter()
        archives = [
            convert(LOC_NAME, {LOC_LAYER: [{"file": str(loc), "minzoom": MINZOOM, "maxzoom": MAXZOOM}]}, [loc],
                    "WZW voorzieningen, locaties", helpers, interpreter),
            convert(LOOP_NAME, {LOOP_LAYER: [{"file": str(LOOP_DIR / f"{r}.geojson"), "minzoom": lo, "maxzoom": hi} for r, (lo, hi) in LOOP_BANDS.items()]},
                    [LOOP_DIR / f"{r}.geojson" for r in LOOP_BANDS], "WZW voorzieningen, loopafstanden (m)", helpers, interpreter),
        ]
        if args.upload:
            helpers.upload(archives, REMOTE)

    if args.config:
        stats = loop_stats(loop_fields, helpers)
        for variant, its in items.items():
            write_config(variant, its, stats, args.stamp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
