#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.24",
#   "rasterio>=1.3",
#   "gdal>=3.6",
# ]
# ///
"""Build the ``nl2120`` variant of the objectvision config from the TKI NL2120 delivery.

The RSopen NL2120 delivery (Productierun_20260910) holds one folder per
scenario -- BAU1, BAU2, NbSGenuanceerd, NbSGenuanceerder -- each with the same
set of 25 m GeoTIFFs over the Netherlands (RD New, 11200 x 13000 cells). This
driver picks the same ten maps from every scenario, converts them to web
formats with the sibling converters, and writes the variant's config:

    D:/SourceData/NL2120/<scenario>/kaarten_Y2120/NieuweNatuur.tif
      -> pmtiles/nl2120/<scenario>/nieuwe_natuur.pmtiles     (layer "nieuwe_natuur")
    D:/SourceData/NL2120/<scenario>/kaarten_Y2120/LandgebruikskaartHoofdklasse_Y2120.tif
      -> cog/nl2120/<scenario>/landgebruik_2120.cog.tif

    configs/objectvision/nl2120/layers.json       40 layers, 10 per scenario
    configs/objectvision/nl2120/navigation.json   one group per scenario, then
                                                  16 left/right comparison groups
                                                  (every ordered scenario pair)

**PMTiles where the geometry allows it, COG otherwise.** A classified raster
becomes one polygon per connected region of equal cells. For the 0/1 maps
(nieuwe natuur, verstedelijking, seizoensberging veen) that is tens to hundreds
of thousands of polygons, which tile fine, so they go through
``convert-tif-to-geojson.py`` and ``convert-geojson-to-pmtiles.py``. The land use
maps come to ~5.4 million polygons each: they, and the continuous maps (which
the vectoriser cannot handle at all), go through ``convert-tif-to-cog.py`` as a
single-band COG styled with ``band0`` rules. The 0/1 decision is made per file
by counting the regions; past ``--max-polygons`` a map falls back to COG, and so
does a map with no cells at all (seizoensberging veen in BAU), because an empty
GeoJSON cannot be tiled.

**Staging.** The delivery's tifs carry no NoData tag (GeoDMS writes 255, NaN, or
0 for the 1-bit maps) and the 1-bit maps have no CRS, only a ``.tfw``. The
converters take both from the file, so every source is first copied to
``tif/nl2120/`` with the nodata value and EPSG:28992 set.

**Classes and colours** of the land use maps come from ``codetabellen.json``, the
code table published with the delivery (gist cfb4b824...). Units and
descriptions of the other maps come from the same file. Pass ``--codetabellen``
to use a local copy; otherwise it is downloaded once and cached.

**One legend per map, shared by all scenarios.** The class breaks of each
continuous map are computed from the four scenarios pooled, so the same colour
means the same value in BAU1 and in NbSGenuanceerd and a side-by-side
comparison reads correctly. They are stored in the build manifest, so
``--config-only`` regenerates the config without re-reading the rasters.

The basisjaar land use is the same file in every scenario (identical md5), so it
is built once and the four scenario groups all point to it.

Needs the GDAL Python bindings (``osgeo``), rasterio and rio-cogeo, and mapshaper
(``npx mapshaper``) for the vectoriser. On Windows the GDAL bindings may come
from OSGeo4W; the current interpreter is used when it has them, otherwise
``C:\\OSGeo4W\\bin\\python-qgis.bat``.

With ``--upload`` the outputs are copied to the data host behind
``https://data.derondekaart.nl/{pmtiles,cog}/nl2120/``, through a staging folder
and a ``mv`` so a viewer never range-reads a half-written file.

Usage:
    # Everything: stage, convert, write the config
    python3 build-tki-nl2120.py

    # One scenario, or one map, for tuning
    python3 build-tki-nl2120.py --scenario NbSGenuanceerd --only nieuwe_natuur

    # Resume an interrupted run
    python3 build-tki-nl2120.py --skip-existing

    # Rewrite the config from what is already built
    python3 build-tki-nl2120.py --config-only

    # Publish what is already built
    python3 build-tki-nl2120.py --skip-existing --upload
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from osgeo import gdal
from rasterio.features import shapes

gdal.UseExceptions()

HERE = Path(__file__).resolve().parent
TIF_TO_COG = HERE / "convert-tif-to-cog.py"
TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

DEFAULT_SOURCE = Path(r"D:\SourceData\NL2120")
STAGE_ROOT = HERE / "tif" / "nl2120"
GEOJSON_ROOT = HERE / "geojson" / "nl2120"
PMTILES_ROOT = HERE / "pmtiles" / "nl2120"
COG_ROOT = HERE / "cog" / "nl2120"
MANIFEST = STAGE_ROOT / "manifest.json"
CODETABELLEN_CACHE = STAGE_ROOT / "codetabellen.json"
CONFIG_DIR = HERE.parent / "configs" / "objectvision" / "nl2120"

GIST_API = "https://api.github.com/gists/cfb4b824a1f9c48e6e031ab594bac90c"
BASE_URL = "https://data.derondekaart.nl"
DEFAULT_REMOTE = "objectvision@37.97.226.58:/var/www/objectvision_data"

# Only used as a fallback when the current interpreter has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

# Windows ships OpenSSH here. Prefer it over anything earlier on PATH: the
# MSYS/Git-for-Windows build of ssh cannot talk to the Windows ssh-agent.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

RD_NEW = "EPSG:28992"
DEFAULT_MAX_POLYGONS = 1_000_000

# Layer descriptions are left out of the config for now; flip to bring them back.
WRITE_DESCRIPTIONS = False

# Folder name in the delivery, id slug, label in the navigation.
SCENARIOS = (
    ("BAU1", "bau1", "BAU1"),
    ("BAU2", "bau2", "BAU2"),
    ("NbSGenuanceerd", "nbsgenuanceerd", "NbS genuanceerd"),
    ("NbSGenuanceerder", "nbsgenuanceerder", "NbS genuanceerder"),
)

# Output folder of the files that are identical in every scenario.
SHARED = "basisjaar"

SEQ_BLUE = ("#ffffcc", "#c7e9b4", "#7fcdbb", "#41b6c4", "#2c7fb8", "#253494")
SEQ_RED = ("#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026")
# Diverging, negative first: red is loss, blue/green is gain.
DIV_RED_BLUE = ("#b2182b", "#d6604d", "#f4a582", "#fddbc7", "#d1e5f0", "#92c5de", "#4393c3", "#2166ac")
DIV_BROWN_GREEN = ("#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#c7eae5", "#80cdc1", "#35978f", "#01665e")


@dataclass(frozen=True)
class Layer:
    suffix: str
    path: str  # relative to the scenario folder
    kind: str  # "landuse" | "binary" | "sequential" | "diverging"
    name: str
    description: str = ""
    shared: bool = False  # the same file in every scenario: built once
    color: str = "#000000"  # binary maps
    palette: tuple[str, ...] = ()  # continuous maps
    percent: bool = False  # label a 0-1 fraction as a percentage
    keep_zero: bool = False  # sequential: 0 is a value, not "nothing here"


LAYERS = (
    Layer(
        "landgebruik_basisjaar",
        "kaarten_basisjaar/LandgebruikskaartHoofdklasse_Basisjaar.tif",
        "landuse",
        "Landgebruik basisjaar",
        "Landgebruik in het basisjaar, in de 43 hoofdklassen van NL2120. Gelijk in alle scenario's.",
        shared=True,
    ),
    Layer(
        "landgebruik_2120",
        "kaarten_Y2120/LandgebruikskaartHoofdklasse_Y2120.tif",
        "landuse",
        "Landgebruik 2120",
        "Landgebruik in 2120, in de 43 hoofdklassen van NL2120.",
    ),
    Layer("nieuwe_natuur", "kaarten_Y2120/NieuweNatuur.tif", "binary", "Nieuwe natuur", color="#2e8b57"),
    Layer("verstedelijking", "kaarten_Y2120/Verstedelijking.tif", "binary", "Verstedelijking", color="#d7301f"),
    Layer(
        "waterberging_veen",
        "kaarten_Y2120/WaterbergingVeen.tif",
        "binary",
        "Seizoensberging veen",
        color="#2b8cbe",
    ),
    Layer(
        "piekbuiberging",
        "kaarten_Y2120/Piekbuiberging_Dekkingsgraad_per500m.tif",
        "sequential",
        "Piekbuiberging, dekkingsgraad",
        palette=SEQ_BLUE,
        percent=True,
        keep_zero=True,
    ),
    Layer(
        "co2_veenoxidatie",
        "kaarten_Y2120/SOMERS_CO2_Emissies_kg_Mediaan_Cumulatief_sindsStartyear_Y2120.tif",
        "sequential",
        "CO2-emissie veenoxidatie tot 2120",
        palette=SEQ_RED,
    ),
    Layer(
        "bodemkoolstof",
        "kaarten_Y2120/CarbonStorageSequestration_stock_FromBaseYear_Y2120_tonCO2.tif",
        "diverging",
        "Bodemkoolstof t.o.v. basisjaar",
        "Verandering van de koolstofvoorraad in de bodem sinds het basisjaar; positief betekent aangroei.",
        palette=DIV_BROWN_GREEN,
    ),
    Layer(
        "vermeden_sterfte",
        "kaarten_Y2120/Mortaliteit_SterfteAfname_Cumulatief_Y2120.tif",
        "diverging",
        "Vermeden sterfte door groen",
        "Een groenindex-effect, geen gezondheidsmodel: het teken hangt deels af van de methode.",
        palette=DIV_RED_BLUE,
    ),
    Layer(
        "woningwaarde_groen",
        "kaarten_Y2120/WaardeVeranderingDoorGroenVerandering_Woningen_Y2120.tif",
        "diverging",
        "Woningwaarde door groenverandering",
        palette=DIV_RED_BLUE,
    ),
)


# --- code tables --------------------------------------------------------------


def load_codetabellen(path: Path | None) -> dict:
    """The delivery's code table: from ``path``, the cache, or the gist."""
    if path is not None:
        return json.loads(path.read_text(encoding="utf-8"))
    if not CODETABELLEN_CACHE.is_file():
        print(f"Downloading codetabellen.json from {GIST_API}")
        request = urllib.request.Request(GIST_API, headers={"Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            gist = json.load(response)
        entry = gist["files"]["codetabellen.json"]
        content = entry["content"]
        if entry.get("truncated"):
            with urllib.request.urlopen(entry["raw_url"], timeout=60) as response:
                content = response.read().decode("utf-8")
        CODETABELLEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
        CODETABELLEN_CACHE.write_text(content, encoding="utf-8")
    return json.loads(CODETABELLEN_CACHE.read_text(encoding="utf-8"))


def map_entry(codetabellen: dict, layer: Layer) -> dict:
    """The code table's description of one map, matched on its delivery path."""
    delivery_path = f"Oplevering/BAU1/{layer.path}"
    for entry in codetabellen["kaarten"] + codetabellen["continue_kaarten"]:
        if re.match(entry["regex"], delivery_path):
            return entry
    return {}


# --- staging and conversion ---------------------------------------------------


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


def stage(source: Path, target: Path, kind: str) -> Path:
    """Copy ``source`` with its nodata value and CRS set, as the converters need."""
    if target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
        return target
    nodata = {"landuse": 255, "binary": 0}.get(kind, float("nan"))
    options = {
        "noData": nodata,
        "creationOptions": ["COMPRESS=DEFLATE", "TILED=YES", "BIGTIFF=IF_SAFER"],
    }
    if kind == "binary":
        # The 1-bit tifs read as 0/1 bytes; write them as plain bytes.
        options["outputType"] = gdal.GDT_Byte
    if not gdal.Info(str(source), format="json").get("coordinateSystem", {}).get("wkt"):
        options["outputSRS"] = RD_NEW
    target.parent.mkdir(parents=True, exist_ok=True)
    gdal.Translate(str(target), str(source), **options)
    return target


def count_regions(path: Path) -> int:
    """Number of polygons vectorising the 1-cells of a 0/1 raster would give."""
    with rasterio.open(path) as src:
        band = src.read(1)
    mask = band == 1
    if not mask.any():
        return 0
    return sum(1 for _ in shapes(band, mask=mask, connectivity=4))


def run(command: list[str]) -> None:
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: {Path(command[1]).name} failed (exit {result.returncode})")


def build_cog(staged: Path, output: Path, layer: Layer) -> None:
    # The converter's default nearest overviews keep every 2nd, 4th... cell, which
    # turns a 25 m mosaic into speckle when zoomed out. Classes take the dominant
    # class instead, continuous maps the mean; both skip nodata.
    overviews = "mode" if layer.kind in ("landuse", "binary") else "average"
    output.parent.mkdir(parents=True, exist_ok=True)
    run([sys.executable, str(TIF_TO_COG), str(staged), str(output), "--overview-resampling", overviews])


def build_pmtiles(staged: Path, geojson: Path, output: Path, layer_name: str) -> None:
    geojson.parent.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    run([sys.executable, str(TIF_TO_GEOJSON), str(staged), str(geojson), "--classes", "1", "--nodata", "0"])
    run(
        pmtiles_interpreter()
        + [str(GEOJSON_TO_PMTILES), "-o", str(output), "--layer", f"{layer_name}={geojson}"]
    )


def folder(layer: Layer, slug: str) -> str:
    return SHARED if layer.shared else slug


def build_one(layer: Layer, scenario: tuple[str, str, str], args: argparse.Namespace) -> dict:
    """Stage and convert one map of one scenario; returns its manifest entry."""
    directory, slug, _ = scenario
    where = folder(layer, slug)
    source = args.source / directory / layer.path
    if not source.is_file():
        raise SystemExit(f"error: input not found: {source}")
    staged = stage(source, STAGE_ROOT / where / f"{layer.suffix}.tif", layer.kind)

    cog = COG_ROOT / where / f"{layer.suffix}.cog.tif"
    pmtiles = PMTILES_ROOT / where / f"{layer.suffix}.pmtiles"
    entry: dict = {"date": datetime.date.today().strftime("%Y%m%d")}

    if layer.kind == "binary":
        regions = count_regions(staged)
        entry["regions"] = regions
        use_pmtiles = 0 < regions <= args.max_polygons
        reason = "no cells" if regions == 0 else f"{regions:,} regions"
        print(f"  {where}/{layer.suffix}: {reason} -> {'pmtiles' if use_pmtiles else 'cog'}")
        if use_pmtiles:
            entry["format"] = "pmtiles"
            entry["file"] = str(pmtiles.relative_to(HERE))
            geojson = GEOJSON_ROOT / where / f"{layer.suffix}.geojson"
            build_pmtiles(staged, geojson, pmtiles, layer.suffix)
            return entry

    entry["format"] = "cog"
    entry["file"] = str(cog.relative_to(HERE))
    build_cog(staged, cog, layer)
    return entry


# --- legend breaks ------------------------------------------------------------


def round_sig(value: float, digits: int = 2) -> float:
    if value == 0 or not math.isfinite(value):
        return value
    return round(value, digits - 1 - int(math.floor(math.log10(abs(value)))))


def sample(path: Path, max_cells: int = 20_000_000) -> np.ndarray:
    """The finite values of a raster, read decimated when it is large."""
    with rasterio.open(path) as src:
        factor = max(1, math.ceil(math.sqrt(src.width * src.height / max_cells)))
        band = src.read(1, out_shape=(src.height // factor, src.width // factor))
    return band[np.isfinite(band)]


def compute_breaks(layer: Layer, staged: list[Path]) -> list[float]:
    """Class breaks pooled over all scenarios, rounded to two significant figures.

    Sequential maps: five breaks at the sextiles of the non-zero values (zero is
    included when ``keep_zero``). Diverging maps: symmetric breaks around zero at
    the 50th/80th/95th percentile of the absolute non-zero values.
    """
    values = np.concatenate([sample(path) for path in staged])
    if layer.kind == "sequential":
        if not layer.keep_zero:
            values = values[values != 0]
        raw = np.quantile(values, [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6])
        breaks = [round_sig(float(v)) for v in raw]
    else:
        magnitudes = np.abs(values[values != 0])
        raw = np.quantile(magnitudes, [0.5, 0.8, 0.95])
        positive = [round_sig(float(v)) for v in raw]
        breaks = [-v for v in reversed(positive)] + [0.0] + positive
    return sorted(set(breaks))


# --- config -------------------------------------------------------------------


def format_number(value: float, percent: bool) -> str:
    """Dutch notation: 12.345,6 -- or a percentage for a 0-1 fraction."""
    if percent:
        value *= 100
    text = f"{value:,.10g}" if abs(value) >= 1000 else f"{value:.10g}"
    text = text.replace(",", "\0").replace(".", ",").replace("\0", ".")
    return f"{text}%" if percent else text


def fill(name: str, filter_: list, color: str) -> dict:
    return {"name": name, "filter": filter_, "symbolizers": [{"kind": "Fill", "color": color}]}


def landuse_rules(codetabellen: dict) -> list[dict]:
    return [
        fill(c["label"], ["==", "band0", c["code"]], c["kleur_hex"])
        for c in codetabellen["classificaties"]["LU_Hoofdklasse"]
        if c.get("kleur_hex")
    ]


def sequential_rules(layer: Layer, breaks: list[float]) -> list[dict]:
    """``len(breaks) + 1`` classes; the palette is stretched over them."""
    labels = [format_number(b, layer.percent) for b in breaks]
    colors = pick_colors(layer.palette, len(breaks) + 1)
    lowest = [">=", "band0", 0] if layer.keep_zero else [">", "band0", 0]
    rules = [fill(f"< {labels[0]}", ["&&", lowest, ["<", "band0", breaks[0]]], colors[0])]
    for i in range(1, len(breaks)):
        rules.append(
            fill(
                f"{labels[i - 1]} - {labels[i]}",
                ["&&", [">=", "band0", breaks[i - 1]], ["<", "band0", breaks[i]]],
                colors[i],
            )
        )
    rules.append(fill(f">= {labels[-1]}", [">=", "band0", breaks[-1]], colors[-1]))
    return rules


def diverging_rules(layer: Layer, breaks: list[float]) -> list[dict]:
    """Classes on both sides of zero; exactly zero stays transparent."""
    labels = [format_number(b, layer.percent) for b in breaks]
    zero = breaks.index(0.0)
    colors = layer.palette
    rules = [fill(f"< {labels[0]}", ["<", "band0", breaks[0]], colors[0])]
    for i in range(1, len(breaks)):
        low, high = breaks[i - 1], breaks[i]
        if i == zero:
            filter_ = ["&&", [">=", "band0", low], ["<", "band0", 0]]
        elif i == zero + 1:
            filter_ = ["&&", [">", "band0", 0], ["<", "band0", high]]
        else:
            filter_ = ["&&", [">=", "band0", low], ["<", "band0", high]]
        rules.append(fill(f"{labels[i - 1]} - {labels[i]}", filter_, colors[i]))
    rules.append(fill(f">= {labels[-1]}", [">=", "band0", breaks[-1]], colors[len(breaks)]))
    return rules


def pick_colors(palette: tuple[str, ...], count: int) -> list[str]:
    if count >= len(palette):
        return list(palette)
    step = (len(palette) - 1) / max(1, count - 1)
    return [palette[round(i * step)] for i in range(count)]


def layer_config(layer: Layer, scenario: tuple[str, str, str], built: dict, codetabellen: dict,
                 breaks: dict) -> dict:
    _, slug, label = scenario
    entry = map_entry(codetabellen, layer)
    unit = entry.get("eenheid")
    # A fraction or index is per cell by nature; an amount is not.
    per_cell = "" if unit and unit.startswith(("aandeel", "index")) else " per cel"
    description = " ".join(
        part
        for part in (
            layer.description or (entry.get("beschrijving", "").rstrip(".") + "."),
            f"Eenheid: {unit}{per_cell}." if unit else "",
            "Komt in dit scenario niet voor." if built.get("regions") == 0 else "",
            f"Scenario {label}." if not layer.shared else "",
        )
        if part
    )
    url = f"{BASE_URL}/{built['file'].replace(chr(92), '/')}?v={built['date']}"
    config: dict = {
        "id": f"nl2120_{slug}_{layer.suffix}",
        "name": f"{layer.name} ({label})",
    }
    if WRITE_DESCRIPTIONS:
        config["description"] = description
    config["source"] = url
    config["format"] = built["format"]
    if built["format"] == "pmtiles":
        config["sourceLayer"] = layer.suffix
        config["geometryType"] = "polygon"
    config["beforeid"] = "map-layers"
    config["style"] = {"opacity": 0.8}
    if built["format"] == "cog":
        # Past the COG's native zoom the map stretches the tiles; show the cells
        # as hard-edged squares rather than linearly smeared.
        config["style"]["resampling"] = "nearest"
    if built["format"] == "pmtiles":
        config["featureinfo"] = {"template": f"<div><b>{layer.name}</b><br/>Scenario {label}</div>"}

    if layer.kind == "landuse":
        rules = landuse_rules(codetabellen)
    elif layer.kind == "binary":
        band = "class" if built["format"] == "pmtiles" else "band0"
        rules = [fill(layer.name.lower(), ["==", band, 1], layer.color)]
    elif layer.kind == "sequential":
        rules = sequential_rules(layer, breaks[layer.suffix])
    else:
        rules = diverging_rules(layer, breaks[layer.suffix])
    config["geostyler"] = {"name": layer.name, "rules": rules}
    return config


def write_config(manifest: dict, codetabellen: dict) -> None:
    """Write the variant's layers.json and navigation.json -- only once every map is built."""
    wanted = {f"{folder(layer, slug)}/{layer.suffix}" for layer in LAYERS for _, slug, _ in SCENARIOS}
    missing = sorted(wanted - manifest["outputs"].keys())
    if missing:
        print(f"\nConfig not written: {len(missing)} map(s) not built yet ({', '.join(missing[:4])}...)")
        return

    layers, navigation = [], []
    for index, scenario in enumerate(SCENARIOS):
        _, slug, label = scenario
        children = []
        for layer in LAYERS:
            key = f"{folder(layer, slug)}/{layer.suffix}"
            config = layer_config(layer, scenario, manifest["outputs"][key], codetabellen, manifest["breaks"])
            layers.append(config)
            if layer.suffix == "landgebruik_2120":
                continue  # paired with basisjaar below
            children.append({"id": config["id"], "label": layer.name, "a": False, "b": False})
            if layer.suffix == "landgebruik_basisjaar":
                # Basisjaar on the left map, 2120 on the right, in one click.
                children[-1].update(
                    label="Landgebruik basisjaar ↔ 2120",
                    left=config["id"],
                    right=f"nl2120_{slug}_landgebruik_2120",
                )
        navigation.append(
            {"label": label, "icon": "map", "color": "#3E74A7", "expanded": index == 0, "children": children}
        )

    # One comparison group per ordered scenario pair: a leaf puts the left
    # scenario's map on the left map and the right scenario's on the right.
    for _, left_slug, left_label in SCENARIOS:
        for _, right_slug, right_label in SCENARIOS:
            children = []
            for layer in LAYERS:
                left, right = f"nl2120_{left_slug}_{layer.suffix}", f"nl2120_{right_slug}_{layer.suffix}"
                children.append(
                    {"id": left, "label": layer.name, "a": False, "b": False, "left": left, "right": right}
                )
            navigation.append(
                {
                    "label": f"{left_label} ↔ {right_label}",
                    "icon": "compare",
                    "color": "#3E74A7",
                    "expanded": False,
                    "children": children,
                }
            )

    ids = {layer["id"] for layer in layers}
    missing = [
        leaf.get(field)
        for group in navigation
        for leaf in group["children"]
        for field in ("id", "left", "right")
        if field in leaf and leaf[field] not in ids
    ]
    if missing:
        raise SystemExit(f"error: navigation names unknown layers: {missing}")

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in (("layers.json", {"layers": layers}), ("navigation.json", navigation)):
        text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        json.loads(text)
        (CONFIG_DIR / name).write_text(text, encoding="utf-8", newline="\n")
    print(f"\nWrote {CONFIG_DIR / 'layers.json'} ({len(layers)} layers) and navigation.json")


# --- upload -------------------------------------------------------------------


def resolve_ssh_tool(name: str) -> str:
    """Locate an OpenSSH binary, preferring the one Windows ships."""
    if sys.platform == "win32":
        bundled = WINDOWS_OPENSSH / f"{name}.exe"
        if bundled.is_file():
            return str(bundled)
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"error: {name} not found on PATH -- cannot upload")
    return found


def run_ssh(ssh: str, host: str, script: str) -> None:
    result = subprocess.run([ssh, host, script], check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: remote command failed (exit {result.returncode})")


def upload(manifest: dict, remote: str) -> None:
    """Copy every output to the data host, swapping each folder in from staging.

    scp writes straight into the destination file, so copying over a live file
    would let a viewer range-read a truncated one. Staging plus a ``mv`` on the
    same filesystem makes each replacement a rename instead.
    """
    ssh, scp = resolve_ssh_tool("ssh"), resolve_ssh_tool("scp")
    host, _, root = remote.partition(":")
    root = root.rstrip("/")
    stamp = time.strftime("%Y%m%d-%H%M%S")

    groups: dict[str, list[Path]] = {}
    for built in manifest["outputs"].values():
        relative = Path(built["file"])
        groups.setdefault(relative.parent.as_posix(), []).append(HERE / relative)

    for target, files in sorted(groups.items()):
        destination = f"{root}/{target}"
        staging = f"{destination}/.staging-{stamp}"
        total = sum(f.stat().st_size for f in files)
        print(f"\nUploading {len(files)} file(s), {total:,} bytes -> {host}:{destination}")
        run_ssh(ssh, host, f"mkdir -p '{staging}'")
        try:
            result = subprocess.run([scp, *map(str, files), f"{host}:{staging}/"], check=False, text=True)
            if result.returncode != 0:
                raise SystemExit(f"error: scp failed (exit {result.returncode})")
            names = " ".join(f"'{staging}/{f.name}'" for f in files)
            run_ssh(ssh, host, f"mv {names} '{destination}/' && rmdir '{staging}'")
        except BaseException:
            subprocess.run([ssh, host, f"rm -rf '{staging}'"], check=False, capture_output=True)
            raise


# --- main ---------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert the TKI NL2120 maps and write the objectvision nl2120 variant.",
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, metavar="DIR",
                        help=f"NL2120 delivery with one folder per scenario (default: {DEFAULT_SOURCE})")
    parser.add_argument("--codetabellen", type=Path, default=None, metavar="PATH",
                        help="Local codetabellen.json (default: download from the gist, cached)")
    parser.add_argument("--scenario", choices=[s[0] for s in SCENARIOS], action="append",
                        help="Build only this scenario (repeatable; default: all)")
    parser.add_argument("--only", choices=[layer.suffix for layer in LAYERS], action="append",
                        help="Build only this map (repeatable; default: all)")
    parser.add_argument("--max-polygons", type=int, default=DEFAULT_MAX_POLYGONS, metavar="N",
                        help=f"0/1 maps with more regions go to COG instead of PMTiles "
                             f"(default: {DEFAULT_MAX_POLYGONS:,})")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Keep outputs already in the manifest whose file exists")
    parser.add_argument("--config-only", action="store_true",
                        help="Only rewrite the config from the manifest")
    parser.add_argument("--upload", action="store_true", help="Copy the outputs to the data host")
    parser.add_argument("--remote", default=DEFAULT_REMOTE, metavar="USER@HOST:/PATH",
                        help=f"Upload root holding cog/ and pmtiles/ (default: {DEFAULT_REMOTE})")
    args = parser.parse_args(argv[1:])
    sys.stdout.reconfigure(line_buffering=True)

    for script in (TIF_TO_COG, TIF_TO_GEOJSON, GEOJSON_TO_PMTILES):
        if not script.is_file():
            print(f"error: missing sibling script: {script}", file=sys.stderr)
            return 2

    codetabellen = load_codetabellen(args.codetabellen)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    manifest.setdefault("outputs", {})
    manifest.setdefault("breaks", {})

    def save() -> None:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    if not args.config_only:
        scenarios = [s for s in SCENARIOS if not args.scenario or s[0] in args.scenario]
        layers = [layer for layer in LAYERS if not args.only or layer.suffix in args.only]
        for layer in layers:
            print(f"\n== {layer.name}")
            done: set[str] = set()
            for scenario in scenarios:
                key = f"{folder(layer, scenario[1])}/{layer.suffix}"
                if key in done:
                    continue
                done.add(key)
                existing = manifest["outputs"].get(key)
                if args.skip_existing and existing and (HERE / existing["file"]).is_file():
                    print(f"  {key}: exists, skipped")
                    continue
                manifest["outputs"][key] = build_one(layer, scenario, args)
                save()

            # Breaks come from all four scenarios, whichever ones were built now.
            if layer.kind in ("sequential", "diverging"):
                staged = [
                    stage(args.source / d / layer.path, STAGE_ROOT / slug / f"{layer.suffix}.tif", layer.kind)
                    for d, slug, _ in SCENARIOS
                ]
                manifest["breaks"][layer.suffix] = compute_breaks(layer, staged)
                print(f"  breaks: {manifest['breaks'][layer.suffix]}")
                save()

    write_config(manifest, codetabellen)

    if args.upload:
        upload(manifest, args.remote)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
