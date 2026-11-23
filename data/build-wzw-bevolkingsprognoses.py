#!/usr/bin/env python3
"""Build the bevolkingsprognose archives and layers of objectvision's WZW variants.

Five regions have a prognose. Each one gets three archives in
``pmtiles/bevolkingsprognoses/``, one per *kind*, as in MapGallery:

* ``bevprog_<rg>_percentage.pmtiles`` — share of persons per age class (relatief)
* ``bevprog_<rg>_absoluut.pmtiles``   — number of persons per age class
* ``bevprog_<rg>_huishoudens.pmtiles`` — households, OOSR, mantelzorg, inwoners

Each archive has one source-layer per year (``Y2024`` … ``Y2045``; Gelderland's
source stops at 2040), and the app's timeseries slider switches between them.
Every year layer is fed by four GeoDMS exports, banded by zoom as in
``WoonZorgwijzer_clientside_rendering/scripts/convert_prognose_zh_to_single_tiles.sh``:
cells averaged to 500 m up to z8, to 200 m at z9-10, and the simplified 100 m grid
(m10, m5) from z11 on. The values are already classes (uint8): the GeoDMS
template ``cbs100m_bevolkings_prognose_to_vectortile_input`` classifies them.

Steps — run any combination, each skips work that is already up to date:

``--geodms``
    Run GeoDMS for each region whose exports are missing:
    ``/Brondata/CBS_100m_vector_grid/data/Y2026/bevolkingsprognoses/prognose_<regio>/export/<res>/generate``
    in ``cfg/stam.dms``. Without it the build stops and lists what is missing.
(build)
    ``convert-geojson-to-pmtiles.py --spec`` per region and kind.
``--upload``
    Publish to ``ov-data:/var/www/objectvision_data/pmtiles/bevolkingsprognoses``.
``--config``
    Write the layers into ``configs/objectvision/<variant>/layers.json`` and a
    top-level "Bevolkingsprognoses" group into its ``navigation.json``. The items
    come from the ``demografie`` bookmark of the region's MapGallery collection
    (``wzw5_mapgallery/MapGallery_collections_export.json``) and their styles
    from ``MapGallery_layers_export.json``. Existing ``bevprog_*`` entries are
    replaced, so the step can be rerun.

MapGallery filters four of these layers on the wrong field (title "75 plussers",
filter on 67-75): ``FIELD_FIXES`` corrects them, and every field is checked
against the exported GeoJSON before anything is written.

Usage:
    python data/build-wzw-bevolkingsprognoses.py --geodms                  # export + build all
    python data/build-wzw-bevolkingsprognoses.py --regions ge,zl --upload
    python data/build-wzw-bevolkingsprognoses.py --config --no-build        # config only
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

GEODMS_EXE = Path("C:/Program Files/ObjectVision/GeoDms20.24.2.m/GeoDmsRun.exe")
GEODMS_CFG = Path("C:/Users/Cicada/prj/WZW/WoonZorgwijzer_clientside_rendering/cfg/stam.dms")
GEODMS_ITEM = "/Brondata/CBS_100m_vector_grid/data/Y2026/bevolkingsprognoses/prognose_{region}/export/{res}/generate"
GEOJSON_ROOT = Path("C:/LocalData/woonzorgwijzer_clientside_rendering/cbs100m_grid_data/2026")

OUT_DIR = HERE / "pmtiles" / "bevolkingsprognoses"
REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/bevolkingsprognoses"
URL = "https://data.derondekaart.nl/pmtiles/bevolkingsprognoses/{name}?v={stamp}"

MAPGALLERY = HERE / "wzw5_mapgallery"
CONFIGS = REPO / "configs" / "objectvision"


@dataclass(frozen=True)
class Region:
    variant: str
    code: str          # bevprog_<code>_…
    geodms: str        # prognose_<geodms> in brondata.dms
    collection: int    # MapGallery collection id
    first: int
    last: int

    @property
    def years(self) -> range:
        return range(self.first, self.last + 1)


REGIONS = {
    r.code: r
    for r in (
        Region("wzw_noord_holland", "nh", "noord_holland", 185, 2024, 2045),
        Region("wzw_zuid_holland", "zh", "zuid_holland", 199, 2024, 2045),
        Region("wzw_zeeland", "zl", "zeeland", 192, 2024, 2045),
        Region("wzw_noord_brabant", "nb", "noord_brabant", 186, 2024, 2045),
        # gelderland_prognose_grid.csv has no 2045 columns; GeoDMS holds
        # 2041-2045 at the 2040 value, which is not worth publishing.
        Region("wzw_gelderland", "ge", "gelderland", 187, 2024, 2040),
    )
}

# kind -> (folder under GEOJSON_ROOT, file stem before _<year>_<res>)
KINDS = {
    "percentage": ("bevolking", "bevprog_{code}_percentage"),
    "absoluut": ("bevolking", "bevprog_{code}_absoluut"),
    "huishoudens": ("huishoudens", "bevprog_{code}"),
}

# resolution -> zoom band. m20 is still exported by GeoDMS but no longer used.
BANDS = {"m500": (5, 8), "m200": (9, 10), "m10": (11, 12), "m5": (13, 15)}
MINZOOM, MAXZOOM = 5, 15
MAX_SIZE = 2_000_000
MAX_FEATURES = 1_000_000

# MapGallery layer id -> the field its title means; its own filter names another.
FIELD_FIXES = {
    571: "P_lfthh18_29",  # ZH "huishoudens 18 - 29 jarigen" filtered on P_alleen
    524: "P_lft75_plus",  # NB "75 plussers" filtered on P_lft67_75
    505: "P_lft18_29",    # GE "18 - 29 jarigen" filtered on P_lft45_66
    499: "lft00_17",      # GE "0 - 17 jarigen" filtered on lft30_44
}

# Fields exported for one year only (inw: the source is bevolkingsdichtheid 2024),
# so their layer has no timeseries. MapGallery animates it over empty years.
SINGLE_YEAR = {"inw": 2024}

NAV_GROUP = "Bevolkingsprognoses"
NAV_COLOR = "#3E74A7"
# MapGallery subheading -> icon of its navigation subgroup
SUBGROUP_ICONS = {
    "aandeel naar leeftijdsklasse": "percent",
    "aantal naar leeftijdsklasse": "groups",
    "aandeel huishoudens naar leeftijdsklasse": "home_work",
    "aandeel huishoudens naar samenstelling": "diversity_3",
    "mantelzorg": "volunteer_activism",
}


def load_helpers():
    spec = importlib.util.spec_from_file_location("build_wijk_buurt", HERE / "build-wijk-buurt.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source(region: Region, kind: str, year: int, res: str) -> Path:
    folder, stem = KINDS[kind]
    return GEOJSON_ROOT / folder / f"{stem.format(code=region.code)}_{year}_{res}.geojson"


def missing_resolutions(region: Region) -> list[str]:
    return [
        res
        for res in BANDS
        if any(not source(region, kind, year, res).is_file() for kind in KINDS for year in region.years)
    ]


# --- GeoDMS ----------------------------------------------------------------

def run_geodms_item(item: str, what: str, exe: Path) -> None:
    """Calculate one GeoDMS item of ``stam.dms``; GeoDmsRun exits 0 on some
    errors, so its log is scanned for [E]/[F] lines too."""
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    print(f"  {what} GeoDMS …", flush=True)
    started = time.time()
    result = subprocess.run([str(exe), str(GEODMS_CFG), item], env=env, capture_output=True, text=True, check=False)
    log = (result.stdout + result.stderr).splitlines()
    errors = [line for line in log if line.startswith(("[E]", "[F]"))]
    if result.returncode != 0 or errors:
        sys.stderr.write("\n".join((errors or log)[-20:]) + "\n")
        raise SystemExit(f"error: GeoDMS failed on {item} (exit {result.returncode})")
    print(f"  {what} GeoDMS done in {time.time() - started:.0f}s", flush=True)


def run_geodms(region: Region, resolutions: list[str], exe: Path) -> None:
    for res in resolutions:
        run_geodms_item(GEODMS_ITEM.format(region=region.geodms, res=res), f"{region.code} {res}", exe)


# --- PMTiles ---------------------------------------------------------------

def build_archive(region: Region, kind: str, helpers, interpreter: list[str]) -> Path:
    out = OUT_DIR / f"bevprog_{region.code}_{kind}.pmtiles"
    spec = {
        f"Y{year}": [
            {"file": str(source(region, kind, year, res)), "minzoom": lo, "maxzoom": hi}
            for res, (lo, hi) in BANDS.items()
        ]
        for year in region.years
    }
    inputs = [Path(band["file"]) for bands in spec.values() for band in bands]
    if helpers.is_fresh(out, inputs):
        print(f"  {out.name:<34} up to date ({out.stat().st_size:,} bytes)")
        return out

    # The PMTiles driver leaves its temp files behind when killed; a rerun then
    # fails in CREATE TABLE (see build-wzw5-pmtiles.py).
    for leftover in OUT_DIR.glob(f"{out.name}.tmp.mbtiles*"):
        leftover.unlink()
    spec_path = OUT_DIR / f"{out.stem}.spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")

    print(f"  {out.name:<34} building from {len(inputs)} files …", flush=True)
    started = time.time()
    helpers.run(
        [
            *interpreter, str(helpers.CONVERT_PMTILES),
            "--spec", str(spec_path),
            "-o", str(out),
            "--minzoom", str(MINZOOM), "--maxzoom", str(MAXZOOM),
            "--max-size", str(MAX_SIZE), "--max-features", str(MAX_FEATURES),
            "--name", out.stem,
            "--description", f"Bevolkingsprognose {region.geodms} {kind} {region.first}-{region.last}",
        ],
        out.name,
    )
    spec_path.unlink()
    print(f"  {out.name:<34} built in {time.time() - started:.0f}s ({out.stat().st_size:,} bytes)", flush=True)
    return out


# --- config ----------------------------------------------------------------

def geojson_fields(region: Region, kind: str) -> set[str]:
    """Property names of an export, read from its first feature."""
    path = source(region, kind, region.first, "m500")
    with path.open(encoding="utf-8") as handle:
        head = handle.read(64_000)
    # Only features: the crs object has a "properties" member too. GDAL leaves
    # out null fields, so take the union over the first features.
    found = re.findall(r'"type":\s*"Feature",\s*"properties":\s*(\{[^}]*\})', head)
    if not found:
        raise SystemExit(f"error: no feature properties in {path}")
    return set().union(*(json.loads(props) for props in found))


def describe(metadata: str | None) -> str:
    """The first line of MapGallery's 'Omschrijving' as plain text: what the
    map shows. The lines after it are about the source and its method."""
    if not metadata:
        return ""
    text = re.sub(r"^\s*</B>\s*<BR>", "", metadata.split("Omschrijving:", 1)[-1])
    text = re.split(r"<BR>\s*<BR>|<P>|Bronnen:", text, maxsplit=1)[0]
    line = next((l for l in text.splitlines() if l.strip()), "")
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", line))).strip()


def kind_of(layername: str) -> str:
    for kind in ("percentage", "absoluut", "huishoudens"):
        if kind in layername:
            return kind
    raise SystemExit(f"error: no kind for MapGallery layer {layername!r}")


def demografie_items(region: Region, mg_layers: dict[int, dict]):
    """(subheading or None, MapGallery layer, item title) per layer, in order."""
    collections = json.loads((MAPGALLERY / "MapGallery_collections_export.json").read_text(encoding="utf-8"))
    collection = next(c for c in collections if c["id"] == region.collection)
    bookmark = next(b for b in collection["bookmarks"] if b["title"] == "demografie")
    heading = None
    for item in bookmark["items"]:
        layer = item.get("layer")
        if not layer:
            heading = item["title"]
            continue
        yield heading, mg_layers[layer["id"]], item["title"]


def layer_entry(region: Region, heading: str | None, mg: dict, title: str, fields: dict[str, set[str]], stamp: str) -> dict:
    kind = kind_of(mg["layername"])
    rules = mg["geostyler"]["rules"]
    field = FIELD_FIXES.get(mg["id"]) or rules[0]["filter"][1]
    if mg["id"] in FIELD_FIXES:
        print(f"  {region.code}: MapGallery {mg['id']} {title!r}: field {rules[0]['filter'][1]} -> {field}")
    if field not in fields[kind]:
        raise SystemExit(f"error: {region.code} MapGallery {mg['id']} {title!r}: no field {field} in the {kind} export")
    name = f"bevprog_{region.code}_{kind}.pmtiles"
    subname = heading or ("bevolkingsdichtheid" if field in SINGLE_YEAR else kind)
    entry = {
        "id": f"bevprog_{kind}_{field.lower()}",
        "name": title,
        "subname": subname,
        "description": describe(mg.get("metadata")),
        "source": URL.format(name=name, stamp=stamp),
        "format": "pmtiles",
        "sourceLayer": "Y%YEAR%",
        "geometryType": "polygon",
        "beforeid": "map-layers",
        "timeseries": {"placeholder": "%YEAR%", "start": region.first, "end": region.last, "step": 1},
    }
    if field in SINGLE_YEAR:
        entry["sourceLayer"] = f"Y{SINGLE_YEAR[field]}"
        del entry["timeseries"]
    return entry | {
        "style": {"opacity": 0.8},
        "featureinfo": {
            "template": f"<div><b>{html.escape(title)}</b> ({html.escape(subname)})<table><tr><td>Klasse</td><td>[[ {field.lower()} ]]</td></tr></table></div>"
        },
        "geostyler": {
            "name": title,
            "rules": [
                {
                    "name": rule["name"].strip(),
                    "filter": ["==", field.lower(), rule["filter"][2]],
                    "symbolizers": [{"kind": "Fill", "color": rule["symbolizers"][0]["color"], "outlineWidth": 0}],
                }
                for rule in rules
            ],
        },
    }


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def write_config(region: Region, stamp: str) -> None:
    mg_layers = {l["id"]: l for l in json.loads((MAPGALLERY / "MapGallery_layers_export.json").read_text(encoding="utf-8"))}
    # The PMTiles converter lowercases field names, so the style does too.
    fields = {kind: geojson_fields(region, kind) for kind in KINDS}

    entries: list[dict] = []
    nav: list[dict] = []
    groups: dict[str, dict] = {}
    for heading, mg, title in demografie_items(region, mg_layers):
        entry = layer_entry(region, heading, mg, title, fields, stamp)
        if any(e["id"] == entry["id"] for e in entries):
            raise SystemExit(f"error: {region.code}: duplicate layer id {entry['id']}")
        entries.append(entry)
        leaf = {"id": entry["id"], "label": title, "a": False, "b": False}
        if heading is None:
            nav.append(leaf)
            continue
        if heading not in groups:
            groups[heading] = {
                "label": heading[0].upper() + heading[1:],
                "icon": SUBGROUP_ICONS.get(heading, "monitoring"),
                "color": NAV_COLOR,
                "expanded": not groups,
                "children": [],
            }
            nav.append(groups[heading])
        groups[heading]["children"].append(leaf)

    folder = CONFIGS / region.variant
    layers_path, nav_path = folder / "layers.json", folder / "navigation.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    kept = [l for l in layers["layers"] if not l["id"].startswith("bevprog_")]
    at = next((i for i, l in enumerate(kept) if l["id"] == "wzw_studiegebied"), len(kept))
    layers["layers"] = kept[:at] + entries + kept[at:]
    write_json(layers_path, layers)

    navigation = json.loads(nav_path.read_text(encoding="utf-8"))
    navigation = [g for g in navigation if g.get("label") != NAV_GROUP]
    group = {"label": NAV_GROUP, "icon": "monitoring", "color": NAV_COLOR, "expanded": False, "children": nav}
    at = next((i + 1 for i, g in enumerate(navigation) if g.get("label") == "WoonZorgwijzer 5.0"), len(navigation))
    navigation.insert(at, group)
    write_json(nav_path, navigation)
    print(f"  {region.variant:<18} {len(entries)} layers -> layers.json, navigation.json")


# --- main ------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the WZW bevolkingsprognose PMTiles and config.")
    parser.add_argument("--regions", default=",".join(REGIONS), help=f"comma-separated subset of {','.join(REGIONS)}")
    parser.add_argument("--kinds", default=",".join(KINDS), help=f"comma-separated subset of {','.join(KINDS)}")
    parser.add_argument("--geodms", action="store_true", help="run GeoDMS for missing exports")
    parser.add_argument("--geodms-exe", type=Path, default=GEODMS_EXE)
    parser.add_argument("--no-build", action="store_true", help="skip the PMTiles step")
    parser.add_argument("--upload", action="store_true", help="publish the archives to ov-data")
    parser.add_argument("--config", action="store_true", help="write layers.json and navigation.json")
    parser.add_argument("--stamp", default=time.strftime("%Y%m%d"), help="?v= cache stamp in the layer URLs")
    args = parser.parse_args(argv[1:])

    regions = [REGIONS[c] for c in args.regions.split(",")]
    kinds = args.kinds.split(",")
    for kind in kinds:
        if kind not in KINDS:
            raise SystemExit(f"error: unknown kind {kind}")

    building = not args.no_build or args.upload
    for region in regions:
        missing = missing_resolutions(region) if building or args.geodms else []
        if not missing:
            continue
        if not args.geodms:
            items = "\n".join("  " + GEODMS_ITEM.format(region=region.geodms, res=r) for r in missing)
            raise SystemExit(f"error: {region.code}: exports missing for {', '.join(missing)}; run with --geodms or:\n{items}")
        run_geodms(region, missing, args.geodms_exe)
        if still := missing_resolutions(region):
            raise SystemExit(f"error: {region.code}: GeoDMS ran but exports are still missing for {', '.join(still)}")

    built: list[Path] = []
    if building:
        helpers = load_helpers()
        interpreter = helpers.pmtiles_interpreter()
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        for region in regions:
            for kind in kinds:
                built.append(build_archive(region, kind, helpers, interpreter))
        if args.upload:
            helpers.upload(built, REMOTE)

    if args.config:
        for region in regions:
            write_config(region, args.stamp)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
