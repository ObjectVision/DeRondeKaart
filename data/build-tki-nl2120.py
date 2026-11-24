#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.24",
#   "rasterio>=1.3",
#   "gdal>=3.6",
# ]
# ///
"""Build the ``nl2120`` variant's layers of the objectvision config from the TKI NL2120 delivery.

The RSopen NL2120 delivery (Productierun_20260910, folder ``Oplevering``) holds
one folder per scenario -- BAU1, BAU2, NbSGenuanceerd, NbSGenuanceerder -- each
with 25 m GeoTIFFs over the Netherlands (RD New, 11200 x 13000 cells) in three
subfolders:

    kaarten_basisjaar/   reference maps of the base year
    kaarten_Y2120/       the maps of the final year 2120
    kaarten_tijdreeks/   the same indicators for 2040 ... 2110

Every map in those folders is a **topic**: its file name with the year token
(``_Y2040``, ``_Basisjaar``) taken out. A topic gets one output folder holding
every scenario and year, with both encoded in the file name::

    Oplevering/BAU1/kaarten_tijdreeks/Sloopkosten_NieuweNatuur_Y2060_Eur.tif
      -> cog/nl2120/sloopkosten_nieuwe_natuur_eur/bau1_2060.cog.tif
    Oplevering/<every scenario>/kaarten_basisjaar/LandgebruikskaartHoofdklasse_Basisjaar.tif
      -> cog/nl2120/landgebruik_hoofdklasse/basisjaar.cog.tif   (identical in all four: built once)
    Oplevering/BAU1/kaarten_Y2120/NieuweNatuur.tif
      -> pmtiles/nl2120/nieuwe_natuur/bau1_2120.pmtiles

**Layers.** Per topic and scenario, ``configs/objectvision/nl2120/layers.json``
gets one layer. When that scenario has the topic for several years on a regular
grid (2040-2120 by 10), the layer is a **timeseries**: its COG ``source`` carries
``%YEAR%`` and the legend shows a year slider, opening on the last year. Years
off a regular grid become one layer per year; the base year is always its own
layer. The ten topics built before keep their layer ids, names and colours
(``LEGACY``), because ``navigation.json`` points at them; that file is not
written by this script.

**PMTiles where the geometry allows it, COG otherwise.** A 0/1 map with up to
``--max-polygons`` connected regions, for a single year, is vectorised
(``convert-tif-to-geojson.py`` + ``convert-geojson-to-pmtiles.py``); every other
map -- classes, continuous values, and 0/1 maps that are too fragmented, empty,
or part of a year series -- becomes a single-band COG (``convert-tif-to-cog.py``)
styled with ``band0`` rules.

**Classes and colours** come from ``codetabellen.json`` (gist cfb4b824...), the
code table published with the delivery: which classification a map uses, and
per class its label and colour. A class without a colour gets one from a fixed
categorical palette. Only the classes that occur in the topic's rasters are put
in the legend. Continuous maps get class breaks pooled over every scenario and
year of the topic, so a colour means the same value across the slider and across
scenarios: sequential maps at the sextiles of the non-zero values, maps with
negative values diverging around zero.

**Staging.** The delivery's tifs carry no NoData tag (GeoDMS writes 255, 65535,
4294967295 or NaN, and 0 in the 1-bit maps) and the 1-bit maps have no CRS, only
a ``.tfw``. Every source is first copied to ``tif/nl2120/`` with its nodata value
and EPSG:28992 set.

Conversions run in parallel (``--workers``); progress goes to the console and to
``tif/nl2120/progress.json``. With ``--upload`` the outputs go to the data host
behind ``https://dataov2120.derondekaart.nl/{cog,pmtiles}/nl2120/``, each folder
through a staging folder and a ``mv``, so a viewer never range-reads a
half-written file.

Needs the GDAL Python bindings (``osgeo``), rasterio and rio-cogeo, and
mapshaper (``npx mapshaper``) for the vectoriser.

Usage:
    python build-tki-nl2120.py                        # build everything, write layers.json
    python build-tki-nl2120.py --skip-existing        # resume
    python build-tki-nl2120.py --only nieuwe_natuur   # one topic (folder name), repeatable
    python build-tki-nl2120.py --list                 # show the topics and their years
    python build-tki-nl2120.py --config-only          # rewrite layers.json from the manifest
    python build-tki-nl2120.py --skip-existing --upload
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass, field
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

DEFAULT_SOURCE = Path(r"D:\SourceData\NL2120\NL2120_Productierun_20260910\Oplevering")
STAGE_ROOT = HERE / "tif" / "nl2120"
GEOJSON_ROOT = HERE / "geojson" / "nl2120"
PMTILES_ROOT = HERE / "pmtiles" / "nl2120"
COG_ROOT = HERE / "cog" / "nl2120"
MANIFEST = STAGE_ROOT / "manifest-topics.json"
PROGRESS = STAGE_ROOT / "progress.json"
CODETABELLEN_CACHE = STAGE_ROOT / "codetabellen.json"
CONFIG_DIR = HERE.parent / "configs" / "objectvision" / "nl2120"

GIST_API = "https://api.github.com/gists/cfb4b824a1f9c48e6e031ab594bac90c"
BASE_URL = "https://dataov2120.derondekaart.nl"
DEFAULT_REMOTE = "ov-data:/var/www/ov2120_data"

# Only used as a fallback when the current interpreter has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

# Windows ships OpenSSH here. Prefer it over anything earlier on PATH: the
# MSYS/Git-for-Windows build of ssh cannot talk to the Windows ssh-agent.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

RD_NEW = "EPSG:28992"
DEFAULT_MAX_POLYGONS = 1_000_000
DEFAULT_WORKERS = 8
SUBFOLDERS = ("kaarten_basisjaar", "kaarten_Y2120", "kaarten_tijdreeks")
BASIS = "basisjaar"
PLACEHOLDER = "%YEAR%"

# Layer descriptions are left out of the config for now; flip to bring them back.
WRITE_DESCRIPTIONS = False

# Folder name in the delivery, id slug, label.
SCENARIOS = (
    ("BAU1", "bau1", "BAU1"),
    ("BAU2", "bau2", "BAU2"),
    ("NbSGenuanceerd", "nbsgenuanceerd", "NbS genuanceerd"),
    ("NbSGenuanceerder", "nbsgenuanceerder", "NbS genuanceerder"),
)

SEQ_BLUE = ("#ffffcc", "#c7e9b4", "#7fcdbb", "#41b6c4", "#2c7fb8", "#253494")
SEQ_RED = ("#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026")
SEQ_GREEN = ("#ffffcc", "#d9f0a3", "#addd8e", "#78c679", "#31a354", "#006837")
# Diverging, negative first: red is loss, blue/green is gain.
DIV_RED_BLUE = ("#b2182b", "#d6604d", "#f4a582", "#fddbc7", "#d1e5f0", "#92c5de", "#4393c3", "#2166ac")
DIV_BROWN_GREEN = ("#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#c7eae5", "#80cdc1", "#35978f", "#01665e")
# For classes the code table gives no colour (e.g. the veenbouwstenen).
CATEGORICAL = (
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2",
    "#7f7f7f", "#bcbd22", "#17becf", "#aec7e8", "#ffbb78", "#98df8a", "#ff9896",
)

# GeoDMS's null value per data type, which the delivery writes for "empty".
NODATA_BY_TYPE = {"Byte": 255, "UInt16": 65535, "UInt32": 4294967295, "Float32": float("nan"),
                  "Float64": float("nan")}
# KostenWoningbouw_Alternatief has no empty cells: code 5 fills every cell where
# no alternative was computed, even outside the Netherlands (codetabellen
# LEESMIJ, "CODE 0 EN LEGE CELLEN"). Treat it as empty.
NODATA_OVERRIDE = {"KostenWoningbouw_Alternatief": 5}

# Words that mark a cost or damage: these sequential maps go red, not blue.
RED_WORDS = ("kosten", "schade", "emissie", "co2", "methaan", "gesloopte")


@dataclass(frozen=True)
class Legacy:
    """A topic built before this script went per-topic: its ids, name and look stay."""
    folder: str
    ids: dict  # year (int or BASIS) -> id suffix; "*" for the topic's series/single layer
    name: str
    kind: str = ""  # forces "sequential" / "diverging" / "binary" / "classes"
    color: str = "#000000"
    palette: tuple[str, ...] = ()
    percent: bool = False
    keep_zero: bool = False
    names: dict = field(default_factory=dict)  # year -> name override


LEGACY = {
    "LandgebruikskaartHoofdklasse": Legacy(
        "landgebruik_hoofdklasse",
        {BASIS: "landgebruik_basisjaar", 2120: "landgebruik_2120"},
        "Landgebruik",
        names={BASIS: "Landgebruik basisjaar", 2120: "Landgebruik 2120"},
    ),
    "NieuweNatuur": Legacy("nieuwe_natuur", {"*": "nieuwe_natuur"}, "Nieuwe natuur", "binary", "#2e8b57"),
    "Verstedelijking": Legacy("verstedelijking", {"*": "verstedelijking"}, "Verstedelijking", "binary", "#d7301f"),
    "WaterbergingVeen": Legacy(
        "waterberging_veen", {"*": "waterberging_veen"}, "Seizoensberging veen", "binary", "#2b8cbe"
    ),
    "Piekbuiberging_Dekkingsgraad_per500m": Legacy(
        "piekbuiberging", {"*": "piekbuiberging"}, "Piekbuiberging, dekkingsgraad", "sequential",
        palette=SEQ_BLUE, percent=True, keep_zero=True,
    ),
    "SOMERS_CO2_Emissies_kg_Mediaan_Cumulatief_sindsStartyear": Legacy(
        "co2_veenoxidatie", {"*": "co2_veenoxidatie"}, "CO2-emissie veenoxidatie", "sequential", palette=SEQ_RED
    ),
    "CarbonStorageSequestration_stock_FromBaseYear_tonCO2": Legacy(
        "bodemkoolstof", {"*": "bodemkoolstof"}, "Bodemkoolstof t.o.v. basisjaar", "diverging",
        palette=DIV_BROWN_GREEN,
    ),
    "Mortaliteit_SterfteAfname_Cumulatief": Legacy(
        "vermeden_sterfte", {"*": "vermeden_sterfte"}, "Vermeden sterfte door groen", "diverging",
        palette=DIV_RED_BLUE,
    ),
    "WaardeVeranderingDoorGroenVerandering_Woningen": Legacy(
        "woningwaarde_groen", {"*": "woningwaarde_groen"}, "Woningwaarde door groenverandering", "diverging",
        palette=DIV_RED_BLUE,
    ),
}


# --- discovery ----------------------------------------------------------------


@dataclass
class Topic:
    key: str  # file stem without year, e.g. "Sloopkosten_NieuweNatuur_Eur"
    files: dict = field(default_factory=dict)  # (slug, year) -> Path
    rel: dict = field(default_factory=dict)  # (slug, year) -> "Oplevering/<dir>/<sub>/<name>"
    kind: str = ""  # "classes" | "binary" | "continuous"
    classification: str | None = None
    unit: str | None = None
    shared_basis: bool = False  # the base-year file is identical in every scenario

    @property
    def legacy(self) -> Legacy | None:
        return LEGACY.get(self.key)

    @property
    def folder(self) -> str:
        return self.legacy.folder if self.legacy else slugify(self.key)

    def years(self, slug: str) -> list:
        return sorted((y for s, y in self.files if s == slug), key=lambda y: -1 if y == BASIS else y)


def slugify(key: str) -> str:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key)
    text = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", text)
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", text.lower())).strip("_")


def year_of(stem: str, subfolder: str):
    found = re.search(r"Y(\d{4})|(Basisjaar)", stem)
    if found:
        return BASIS if found.group(2) else int(found.group(1))
    return BASIS if subfolder == "kaarten_basisjaar" else 2120


def topic_key(stem: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"_?(Y\d{4}|Basisjaar)", "", stem)).strip("_")


def discover(source: Path, codetabellen: dict) -> dict[str, Topic]:
    topics: dict[str, Topic] = {}
    for directory, slug, _ in SCENARIOS:
        for sub in SUBFOLDERS:
            folder = source / directory / sub
            if not folder.is_dir():
                raise SystemExit(f"error: not found: {folder}")
            for path in sorted(folder.glob("*.tif")):
                key = topic_key(path.stem)
                year = year_of(path.stem, sub)
                topic = topics.setdefault(key, Topic(key))
                if (slug, year) in topic.files:
                    print(f"  warning: {directory}/{sub}/{path.name} duplicates {topic.files[slug, year]}; skipped")
                    continue
                topic.files[slug, year] = path
                topic.rel[slug, year] = f"Oplevering/{directory}/{sub}/{path.name}"

    for topic in topics.values():
        entry, table = classify(codetabellen, next(iter(topic.rel.values())))
        if topic.legacy and topic.legacy.kind:
            # A legacy "sequential"/"diverging" only fixes the legend shape; the
            # map itself is continuous (mean overviews, pooled breaks).
            topic.kind = "continuous" if topic.legacy.kind in ("sequential", "diverging") else topic.legacy.kind
        elif entry is None:
            topic.kind = "continuous"
        else:
            topic.kind = {"klasse": "classes", "0/1": "binary"}.get(entry.get("soort"), "continuous")
        if topic.kind == "classes":
            topic.classification = (entry or {}).get("classificatie")
            if topic.key == "LandgebruikskaartHoofdklasse":
                topic.classification = "LU_Hoofdklasse"
        topic.unit = (entry or table or {}).get("eenheid")
    return topics


def classify(codetabellen: dict, rel: str) -> tuple[dict | None, dict | None]:
    """(code table entry of a class/0-1 map, continuous-map entry) for one delivery path."""
    for entry in codetabellen["kaarten"]:
        if re.match(entry["regex"], rel):
            return entry, None
    for entry in codetabellen["continue_kaarten"]:
        if re.match(entry["regex"], rel):
            return None, entry
    return None, None


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


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 22), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mark_shared_basis(topics: dict[str, Topic]) -> None:
    """A base-year map identical in all four scenarios is built (and stored) once."""
    for topic in topics.values():
        paths = [topic.files.get((slug, BASIS)) for _, slug, _ in SCENARIOS]
        if all(paths) and len({md5(p) for p in paths}) == 1:
            topic.shared_basis = True


# --- jobs -----------------------------------------------------------------------


@dataclass
class Job:
    topic: Topic
    slug: str  # scenario, or "" for a shared base-year file
    year: object
    source: Path
    series: bool  # part of a multi-year timeseries layer: always COG

    @property
    def name(self) -> str:
        return BASIS if self.year == BASIS and not self.slug else f"{self.slug}_{self.year}"

    @property
    def key(self) -> str:
        return f"{self.topic.folder}/{self.name}"


def series_years(years: list) -> list[int] | None:
    """The numeric years when they form a regular grid of two or more, else None."""
    numeric = [y for y in years if y != BASIS]
    if len(numeric) < 2:
        return None
    steps = {b - a for a, b in zip(numeric, numeric[1:])}
    return numeric if len(steps) == 1 else None


def plan_jobs(topics: dict[str, Topic]) -> list[Job]:
    jobs: list[Job] = []
    for topic in topics.values():
        shared_done = False
        for _, slug, _ in SCENARIOS:
            years = topic.years(slug)
            series = series_years(years) is not None
            for year in years:
                if year == BASIS and topic.shared_basis:
                    if not shared_done:
                        jobs.append(Job(topic, "", BASIS, topic.files[slug, BASIS], False))
                        shared_done = True
                    continue
                jobs.append(Job(topic, slug, year, topic.files[slug, year], series and year != BASIS))
    return jobs


# --- staging and conversion ---------------------------------------------------


def pmtiles_interpreter() -> list[str]:
    """An interpreter that can import the GDAL bindings (``osgeo``)."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for candidate in candidates:
        result = subprocess.run(candidate + ["-c", "import osgeo"], check=False, capture_output=True, text=True)
        if result.returncode == 0:
            return candidate
    raise SystemExit("error: no interpreter found with the GDAL bindings (osgeo).")


def nodata_for(topic: Topic, source: Path):
    if topic.kind == "binary":
        return 0
    if topic.key in NODATA_OVERRIDE:
        return NODATA_OVERRIDE[topic.key]
    band_type = gdal.Info(str(source), format="json")["bands"][0]["type"]
    return NODATA_BY_TYPE.get(band_type, float("nan"))


def stage(job: Job) -> Path:
    """Copy the source with its nodata value and CRS set, as the converters need."""
    target = STAGE_ROOT / job.topic.folder / f"{job.name}.tif"
    if target.is_file() and target.stat().st_mtime >= job.source.stat().st_mtime:
        return target
    options = {
        "noData": nodata_for(job.topic, job.source),
        "creationOptions": ["COMPRESS=DEFLATE", "TILED=YES", "BIGTIFF=IF_SAFER"],
    }
    if job.topic.kind == "binary":
        # The 1-bit tifs read as 0/1 bytes; write them as plain bytes.
        options["outputType"] = gdal.GDT_Byte
    if not gdal.Info(str(job.source), format="json").get("coordinateSystem", {}).get("wkt"):
        options["outputSRS"] = RD_NEW
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".partial.tif")
    gdal.Translate(str(partial), str(job.source), **options)
    partial.replace(target)
    return target


def count_regions(path: Path) -> int:
    """Number of polygons vectorising the 1-cells of a 0/1 raster would give."""
    with rasterio.open(path) as src:
        band = src.read(1)
    mask = band == 1
    if not mask.any():
        return 0
    return sum(1 for _ in shapes(band, mask=mask, connectivity=4))


def run(command: list[str], log: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as handle:
        result = subprocess.run(command, check=False, text=True, stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        raise RuntimeError(f"{Path(command[1]).name} failed (exit {result.returncode}); see {log}")


def build_one(job: Job, max_polygons: int) -> dict:
    """Stage and convert one map; returns its manifest entry."""
    staged = stage(job)
    folder, name = job.topic.folder, job.name
    log = STAGE_ROOT / "logs" / folder / f"{name}.log"
    entry: dict = {"date": datetime.date.today().strftime("%Y%m%d")}

    if job.topic.kind == "binary" and not job.series:
        regions = count_regions(staged)
        entry["regions"] = regions
        if 0 < regions <= max_polygons:
            pmtiles = PMTILES_ROOT / folder / f"{name}.pmtiles"
            geojson = GEOJSON_ROOT / folder / f"{name}.geojson"
            geojson.parent.mkdir(parents=True, exist_ok=True)
            pmtiles.parent.mkdir(parents=True, exist_ok=True)
            run([sys.executable, str(TIF_TO_GEOJSON), str(staged), str(geojson), "--classes", "1", "--nodata", "0"], log)
            run(pmtiles_interpreter() + [str(GEOJSON_TO_PMTILES), "-o", str(pmtiles),
                                          "--layer", f"{folder}={geojson}"], log.with_suffix(".pmtiles.log"))
            entry.update(format="pmtiles", file=pmtiles.relative_to(HERE).as_posix())
            return entry

    cog = COG_ROOT / folder / f"{name}.cog.tif"
    cog.parent.mkdir(parents=True, exist_ok=True)
    # The converter's default nearest overviews keep every 2nd, 4th... cell, which
    # turns a 25 m mosaic into speckle when zoomed out. Classes take the dominant
    # class instead, continuous maps the mean; both skip nodata.
    overviews = "average" if job.topic.kind == "continuous" else "mode"
    run([sys.executable, str(TIF_TO_COG), str(staged), str(cog), "--overview-resampling", overviews], log)
    entry.update(format="cog", file=cog.relative_to(HERE).as_posix())
    return entry


# --- legends ------------------------------------------------------------------


def round_sig(value: float, digits: int = 2) -> float:
    if value == 0 or not math.isfinite(value):
        return value
    return round(value, digits - 1 - int(math.floor(math.log10(abs(value)))))


def sample(path: Path, max_cells: int = 4_000_000) -> np.ndarray:
    """The finite, non-nodata values of a raster, read decimated."""
    with rasterio.open(path) as src:
        factor = max(1, math.ceil(math.sqrt(src.width * src.height / max_cells)))
        band = src.read(1, out_shape=(src.height // factor, src.width // factor), masked=True)
    values = band.compressed() if np.ma.isMaskedArray(band) else band.ravel()
    return values[np.isfinite(values)]


def continuous_legend(topic: Topic, staged: list[Path]) -> dict:
    """Kind ("sequential"/"diverging"/"empty") and pooled class breaks of a topic."""
    values = np.concatenate([sample(path) for path in staged]).astype("float64")
    legacy = topic.legacy
    kind = legacy.kind if legacy and legacy.kind in ("sequential", "diverging") else (
        "diverging" if (values < 0).any() else "sequential"
    )
    if kind == "sequential":
        if not (legacy and legacy.keep_zero):
            values = values[values != 0]
        if values.size == 0:
            return {"kind": "empty", "breaks": []}
        raw = np.quantile(values, [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6])
        breaks = sorted({round_sig(float(v)) for v in raw})
    else:
        magnitudes = np.abs(values[values != 0])
        if magnitudes.size == 0:
            return {"kind": "empty", "breaks": []}
        raw = np.quantile(magnitudes, [0.5, 0.8, 0.95])
        positive = sorted({round_sig(float(v)) for v in raw if v > 0})
        breaks = [-v for v in reversed(positive)] + [0.0] + positive
    return {"kind": kind, "breaks": breaks}


def class_codes(staged: list[Path]) -> list[int]:
    """Every class code that occurs in a topic's rasters (nodata excluded)."""
    codes: set[int] = set()
    for path in staged:
        with rasterio.open(path) as src:
            band = src.read(1, masked=True)
        codes.update(int(c) for c in np.unique(band.compressed()))
    return sorted(codes)


def format_number(value: float, percent: bool) -> str:
    """Dutch notation: 12.345,6 -- or a percentage for a 0-1 fraction."""
    if percent:
        value *= 100
    text = f"{value:,.10g}" if abs(value) >= 1000 else f"{value:.10g}"
    text = text.replace(",", "\0").replace(".", ",").replace("\0", ".")
    return f"{text}%" if percent else text


def fill(name: str, filter_: list, color: str) -> dict:
    return {"name": name, "filter": filter_, "symbolizers": [{"kind": "Fill", "color": color}]}


def pick_colors(palette: tuple[str, ...], count: int) -> list[str]:
    if count >= len(palette):
        return list(palette)
    step = (len(palette) - 1) / max(1, count - 1)
    return [palette[round(i * step)] for i in range(count)]


def sequential_rules(breaks: list[float], palette, percent: bool, keep_zero: bool) -> list[dict]:
    """``len(breaks) + 1`` classes; the palette is stretched over them."""
    labels = [format_number(b, percent) for b in breaks]
    colors = pick_colors(palette, len(breaks) + 1)
    lowest = [">=", "band0", 0] if keep_zero else [">", "band0", 0]
    rules = [fill(f"< {labels[0]}", ["&&", lowest, ["<", "band0", breaks[0]]], colors[0])]
    for i in range(1, len(breaks)):
        rules.append(fill(f"{labels[i - 1]} - {labels[i]}",
                          ["&&", [">=", "band0", breaks[i - 1]], ["<", "band0", breaks[i]]], colors[i]))
    rules.append(fill(f">= {labels[-1]}", [">=", "band0", breaks[-1]], colors[-1]))
    return rules


def diverging_rules(breaks: list[float], palette, percent: bool) -> list[dict]:
    """Classes on both sides of zero; exactly zero stays transparent."""
    labels = [format_number(b, percent) for b in breaks]
    zero = breaks.index(0.0)
    negatives, positives = zero, len(breaks) - zero - 1
    half = len(palette) // 2
    colors = list(palette[half - negatives - 1:half]) + list(palette[half:half + positives + 1])
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


def class_rules(codetabellen: dict, classification: str | None, codes: list[int]) -> list[dict]:
    table = {c["code"]: c for c in codetabellen["classificaties"].get(classification or "", [])}
    rules = []
    for index, code in enumerate(codes):
        entry = table.get(code, {})
        label = entry.get("label") or entry.get("naam") or str(code)
        color = entry.get("kleur_hex") or CATEGORICAL[index % len(CATEGORICAL)]
        rules.append(fill(label, ["==", "band0", code], color))
    return rules


# --- config -------------------------------------------------------------------

UNIT_TOKENS = {"eur", "ton_co2", "job_ha", "won_ha", "meter2", "m2", "ha"}


def topic_name(topic: Topic) -> str:
    if topic.legacy:
        return topic.legacy.name
    words = [w for w in slugify(topic.key).split("_") if w and w not in UNIT_TOKENS]
    text = " ".join(words)
    for word, proper in (("ncw", "NCW"), ("co2", "CO2"), ("ndvi", "NDVI"), ("somers", "SOMERS"),
                         ("ssm", "SSM"), ("abcd", "ABCD"), ("bt ", "BT "), ("npv", "NPV"), ("bbg", "BBG")):
        text = re.sub(rf"\b{word.strip()}\b", proper.strip(), text)
    return text[:1].upper() + text[1:]


def rules_for(topic: Topic, legend: dict, codetabellen: dict, band: str = "band0") -> list[dict]:
    legacy = topic.legacy
    if topic.kind == "classes":
        return class_rules(codetabellen, topic.classification, legend["codes"])
    if topic.kind == "binary":
        color = legacy.color if legacy else "#d95f02"
        return [fill(topic_name(topic).lower(), ["==", band, 1], color)]
    if legend["kind"] == "empty":
        return [fill("geen waarden", [">", "band0", 0], "#bdbdbd")]
    percent = bool(legacy and legacy.percent)
    if legend["kind"] == "sequential":
        palette = legacy.palette if legacy and legacy.palette else (
            SEQ_RED if any(w in topic.key.lower() for w in RED_WORDS) else SEQ_BLUE
        )
        return sequential_rules(legend["breaks"], palette, percent, bool(legacy and legacy.keep_zero))
    palette = legacy.palette if legacy and legacy.palette else (
        DIV_BROWN_GREEN if "carbon" in topic.key.lower() else DIV_RED_BLUE
    )
    return diverging_rules(legend["breaks"], palette, percent)


def layer_id(topic: Topic, slug: str, year, series: bool) -> str:
    legacy = topic.legacy
    if legacy:
        suffix = legacy.ids.get(year) or legacy.ids.get("*")
        if suffix:
            return f"nl2120_{slug}_{suffix}"
    base = topic.folder
    if year == BASIS:
        return f"nl2120_{slug}_{base}_basisjaar"
    return f"nl2120_{slug}_{base}" if series or len([y for y in topic.years(slug) if y != BASIS]) == 1 \
        else f"nl2120_{slug}_{base}_{year}"


def url(built: dict, template_name: str | None = None) -> str:
    file = built["file"]
    if template_name:
        file = f"{file.rsplit('/', 1)[0]}/{template_name}"
    return f"{BASE_URL}/{file}?v={built['date']}"


def layer_entries(topic: Topic, manifest: dict, codetabellen: dict) -> list[dict]:
    legend = manifest["legends"].get(topic.folder, {})
    entries = []
    for _, slug, label in SCENARIOS:
        years = topic.years(slug)
        series = series_years(years)
        groups: list[tuple[object, list]] = []
        if BASIS in years:
            groups.append((BASIS, [BASIS]))
        if series:
            groups.append(("series", series))
        else:
            groups.extend((y, [y]) for y in years if y != BASIS)

        for what, members in groups:
            year = members[-1]
            name_key = BASIS if (year == BASIS and topic.shared_basis) else f"{slug}_{year}"
            built = manifest["outputs"].get(f"{topic.folder}/{name_key}")
            if built is None:
                raise KeyError(f"{topic.folder}/{name_key}")
            is_series = what == "series"
            lid = layer_id(topic, slug, year if not is_series else "*", is_series)
            legacy = topic.legacy
            name = legacy.names.get(year) if legacy and not is_series and year in legacy.names else topic_name(topic)
            if not is_series and not (legacy and year in legacy.names):
                if year == BASIS:
                    name += " basisjaar"
                elif len([y for y in years if y != BASIS]) > 1:
                    name += f" {year}"
            config: dict = {"id": lid, "name": f"{name} ({label})"}
            if WRITE_DESCRIPTIONS and topic.unit:
                config["description"] = f"Eenheid: {topic.unit}. Scenario {label}."
            if is_series:
                config["source"] = url(built, f"{slug}_{PLACEHOLDER}.cog.tif")
            else:
                config["source"] = url(built)
            config["format"] = built["format"]
            if built["format"] == "pmtiles":
                config["sourceLayer"] = topic.folder
                config["geometryType"] = "polygon"
            config["beforeid"] = "map-layers"
            config["style"] = {"opacity": 0.8}
            if built["format"] == "cog":
                # Past the COG's native zoom the map stretches the tiles; show the
                # cells as hard-edged squares rather than linearly smeared.
                config["style"]["resampling"] = "nearest"
            if is_series:
                step = members[1] - members[0]
                config["timeseries"] = {
                    "placeholder": PLACEHOLDER, "start": members[0], "end": members[-1], "step": step,
                    "initial": members[-1], "intervalMs": 1500,
                }
            if built["format"] == "pmtiles":
                config["featureinfo"] = {"template": f"<div><b>{name}</b><br/>Scenario {label}</div>"}
            band = "class" if built["format"] == "pmtiles" else "band0"
            config["geostyler"] = {"name": name, "rules": rules_for(topic, legend, codetabellen, band)}
            entries.append(config)
    return entries


def write_config(topics: dict[str, Topic], manifest: dict, codetabellen: dict) -> None:
    """Write layers.json once every map is built; navigation.json is left alone."""
    layers: list[dict] = []
    ordered = [topics[k] for k in LEGACY if k in topics] + sorted(
        (t for k, t in topics.items() if k not in LEGACY), key=lambda t: t.folder
    )
    try:
        for topic in ordered:
            layers.extend(layer_entries(topic, manifest, codetabellen))
    except KeyError as missing:
        print(f"\nConfig not written: {missing} is not built yet")
        return

    ids = [layer["id"] for layer in layers]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise SystemExit(f"error: duplicate layer ids: {duplicates[:5]}")

    navigation = json.loads((CONFIG_DIR / "navigation.json").read_text(encoding="utf-8"))
    referenced = set()

    def walk(nodes):
        for node in nodes:
            for key in ("id", "left", "right"):
                if node.get(key):
                    referenced.add(node[key])
            walk(node.get("children", []))

    walk(navigation)
    unknown = sorted(referenced - set(ids))
    if unknown:
        raise SystemExit(f"error: navigation.json names layers this build does not produce: {unknown[:5]}")

    text = json.dumps({"layers": layers}, indent=2, ensure_ascii=False) + "\n"
    json.loads(text)
    (CONFIG_DIR / "layers.json").write_text(text, encoding="utf-8", newline="\n")
    print(f"\nWrote {CONFIG_DIR / 'layers.json'} ({len(layers)} layers; navigation.json untouched)")


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
    result = subprocess.run([ssh, "-o", "BatchMode=yes", host, script], check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: remote command failed (exit {result.returncode})")


def upload(manifest: dict, remote: str) -> None:
    """Copy every output to the data host, swapping each folder's files in from staging.

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

    for index, (target, files) in enumerate(sorted(groups.items()), 1):
        destination = f"{root}/{target}"
        staging = f"{destination}/.staging-{stamp}"
        total = sum(f.stat().st_size for f in files)
        print(f"[{index}/{len(groups)}] uploading {len(files)} file(s), {total:,} bytes -> {host}:{destination}")
        run_ssh(ssh, host, f"mkdir -p '{staging}'")
        try:
            result = subprocess.run([scp, "-q", "-o", "BatchMode=yes", *map(str, files), f"{host}:{staging}/"],
                                    check=False, text=True)
            if result.returncode != 0:
                raise SystemExit(f"error: scp failed (exit {result.returncode})")
            names = " ".join(f"'{staging}/{f.name}'" for f in files)
            run_ssh(ssh, host, f"mv {names} '{destination}/' && rmdir '{staging}' && chmod -R a+rX '{destination}'")
        except BaseException:
            subprocess.run([ssh, host, f"rm -rf '{staging}'"], check=False, capture_output=True)
            raise


# --- main ---------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Convert the TKI NL2120 maps and write the nl2120 layers.json.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, metavar="DIR",
                        help=f"the delivery's Oplevering folder (default: {DEFAULT_SOURCE})")
    parser.add_argument("--codetabellen", type=Path, default=None, metavar="PATH",
                        help="Local codetabellen.json (default: download from the gist, cached)")
    parser.add_argument("--only", action="append", metavar="FOLDER", help="Build only this topic (repeatable)")
    parser.add_argument("--max-polygons", type=int, default=DEFAULT_MAX_POLYGONS, metavar="N",
                        help=f"0/1 maps with more regions go to COG (default: {DEFAULT_MAX_POLYGONS:,})")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="parallel conversions")
    parser.add_argument("--skip-existing", action="store_true", help="Keep outputs already built")
    parser.add_argument("--config-only", action="store_true", help="Only rewrite layers.json")
    parser.add_argument("--list", action="store_true", help="List the topics and exit")
    parser.add_argument("--upload", action="store_true", help="Copy the outputs to the data host")
    parser.add_argument("--remote", default=DEFAULT_REMOTE, metavar="HOST:/PATH",
                        help=f"Upload root holding cog/ and pmtiles/ (default: {DEFAULT_REMOTE})")
    args = parser.parse_args(argv[1:])
    sys.stdout.reconfigure(line_buffering=True)

    codetabellen = load_codetabellen(args.codetabellen)
    topics = discover(args.source, codetabellen)
    if args.list:
        for topic in sorted(topics.values(), key=lambda t: t.folder):
            years = {slug: ",".join(map(str, topic.years(slug))) for _, slug, _ in SCENARIOS}
            print(f"{topic.folder:70s} {topic.kind:10s} {years}")
        print(f"{len(topics)} topics")
        return 0
    print(f"{len(topics)} topics; checking which base-year maps are shared ...")
    mark_shared_basis(topics)

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    manifest.setdefault("outputs", {})
    manifest.setdefault("legends", {})
    lock = threading.Lock()

    def save() -> None:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    selected = {k: t for k, t in topics.items() if not args.only or t.folder in args.only}
    if not args.config_only:
        jobs = [j for j in plan_jobs(selected)]
        todo = [j for j in jobs if not (args.skip_existing and j.key in manifest["outputs"]
                                         and (HERE / manifest["outputs"][j.key]["file"]).is_file())]
        total, done, failed = len(todo), 0, []
        started = time.time()
        print(f"{len(jobs)} maps, {total} to build, {args.workers} workers")

        def progress() -> None:
            elapsed = time.time() - started
            rate = done / elapsed if done else 0
            PROGRESS.write_text(json.dumps({
                "phase": "convert", "done": done, "total": total, "failed": len(failed),
                "percent": round(100 * done / total, 1) if total else 100.0,
                "elapsed_s": round(elapsed), "eta_s": round((total - done) / rate) if rate else None,
                "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            }, indent=2), encoding="utf-8")

        progress()
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(build_one, job, args.max_polygons): job for job in todo}
            for future in concurrent.futures.as_completed(futures):
                job = futures[future]
                with lock:
                    done += 1
                    try:
                        manifest["outputs"][job.key] = future.result()
                        save()
                        status = manifest["outputs"][job.key]["format"]
                    except Exception as error:  # noqa: BLE001 - reported, run continues
                        failed.append(job.key)
                        status = f"FAILED: {error}"
                    print(f"[{done}/{total} {100 * done / total:5.1f}%] {job.key}: {status}")
                    progress()
        if failed:
            print(f"\n{len(failed)} map(s) failed: {failed[:10]}")

        print("\nLegends ...")
        for index, topic in enumerate(selected.values(), 1):
            staged = [STAGE_ROOT / topic.folder / f"{j.name}.tif" for j in plan_jobs({topic.key: topic})]
            staged = [p for p in staged if p.is_file()]
            if topic.kind == "classes":
                manifest["legends"][topic.folder] = {"codes": class_codes(staged)}
            elif topic.kind == "continuous":
                manifest["legends"][topic.folder] = continuous_legend(topic, staged)
            else:
                manifest["legends"][topic.folder] = {}
            print(f"  [{index}/{len(selected)}] {topic.folder}: {manifest['legends'][topic.folder]}"[:200])
            save()
        PROGRESS.write_text(json.dumps({"phase": "done", "percent": 100.0, "failed": len(failed),
                                        "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=2),
                            encoding="utf-8")

    write_config(topics, manifest, codetabellen)

    if args.upload:
        upload(manifest, args.remote)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
