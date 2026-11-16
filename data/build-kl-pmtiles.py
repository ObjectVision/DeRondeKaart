#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "numpy>=1.24",
#   "pyogrio>=0.7",
#   "rasterio>=1.3",
#   "shapely>=2.0",
# ]
# ///
"""Build the Kennemerland & IJmond (KL) PMTiles for objectvision/wonenenzorgopdekaart.

The source is the old WZW mirror on ``wzw-legacy``: MapServer config
and data under ``/var/mapserver/kl`` (``kl.map`` -> ``mapfiles/*.map`` -> ``DATA``),
the symbol PNGs under ``/var/mapserver/symbols``, and the map gallery that groups
the layers in ``/var/mapgallery/kl/1.json``. Three of its groups are ported here —
Voorzieningen, Vastgoed and WMO Cliënten; ``build-kl-layers.py`` writes the
matching layers.json / navigation.json entries.

Fetch the sources first, in ONE connection (the host throttles SSH after a few
quick connections, and a PowerShell pipe corrupts binary — run it from Git Bash):

    ssh wzw-legacy 'cd /var/mapserver && tar cf - kl/kl.map \\
        kl/mapfiles kl/templates kl/vector/vrz/basis kl/vector/vrz/soc_wijkt_* \\
        kl/vector/2025/woonzorg kl/vector/woningpand.* kl/vector/woningpand_agg.* \\
        kl/vector/pand_vbo.* kl/vector/pand_vbo_agg.* kl/vector/pand_vbo_2022.* \\
        kl/vector/pand_vbo_agg_2022.* kl/vector/pand_el.* kl/vector/buurt.* \\
        kl/vector/vastgoed/202[234] kl/raster/20*/wmo symbols' > data/kl/kl.tar
    tar xf data/kl/kl.tar -C data/kl/src

so that ``data/kl/src/kl/`` mirrors ``/var/mapserver/kl`` (gitignored, like all
data). Copy ``/var/mapgallery/kl/1.json`` to ``data/kl/src/kl/mapgallery_1.json``.

**Zoom bands from the MapServer scale switches.** Several old layers swapped data
by scale: an aggregate above 1:5000 and single buildings below it, bouwblokken
above 1:10000 and TOP10 blocks below, and 20/10/5 m rasters at 1:50000/1:10000.
Each pair becomes ONE source layer with mutually exclusive zoom bands, which is
what ``convert-geojson-to-pmtiles.py --spec`` requires.

**Timeseries.** The WMO rasters exist per year (``raster/<yyyy>0101/wmo/``) and
koop/huur per year (``vector/vastgoed/<yyyy>/``). Each year becomes its own source
layer (``WMO_HbH_2019`` …, ``koop_2022`` …) so the app's timeseries slider steps
through them with ``sourceLayer: "WMO_HbH_%YEAR%"``.

Shapefiles without a ``.prj`` and the rasters (``.tfw`` only) are RD New, as
kl.map declares; ``EPSG:28992`` is assumed for them. Raster cell value 0 means
"no class" in the old class scheme (only 1-7 are drawn) and is dropped.

Steps are cached — a GeoJSON or archive is rebuilt only when older than its
inputs — so an interrupted run resumes.

Usage:
    python build-kl-pmtiles.py                 # everything
    python build-kl-pmtiles.py --only wmo      # one archive
    python build-kl-pmtiles.py --upload        # build, then publish
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
SRC = HERE / "kl" / "src" / "kl"
WORK = HERE / "kl" / "work"
PMTILES_OUT = HERE / "pmtiles" / "wonenenzorgopdekaart"

SHP_TO_GEOJSON = HERE / "convert-shapefile-to-geojson.py"
TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")
DEFAULT_REMOTE = "ov-data:/var/www/objectvision_data/pmtiles/wonenenzorgopdekaart"
DEFAULT_IDENTITY = Path.home() / ".ssh" / "<key>"

ASSUME_CRS = "EPSG:28992"
MAX_SIZE = 2_000_000
MAX_FEATURES = 1_000_000
SIMPLIFY = 10.0

# WMO trend: gallery theme -> raster stem, and the years the gallery animates.
WMO_YEARS = tuple(str(y) for y in range(2019, 2026))
WMO_THEMES = {
    "WMO_wmo": WMO_YEARS,
    "WMO_HbH": WMO_YEARS,
    "WMO_Begeleiding": WMO_YEARS,
    "WMO_Dagbesteding": WMO_YEARS,
    "WMO_Vervoer": WMO_YEARS,
    # The gallery stops rolstoel at 2024 (its animation max is 20240101).
    "WMO_Rolstoel": WMO_YEARS[:-1],
    "WMO_BeschermdWonen": WMO_YEARS,
}
WMO_BANDS = {"m20": (0, 11), "m10": (12, 13), "m5": (14, 14)}
KOOPHUUR_YEARS = ("2022", "2023", "2024")


class Band(NamedTuple):
    """One input of a source layer: shapefile(s) or a raster, over a zoom range."""
    inputs: tuple[str, ...]   # paths relative to SRC
    minzoom: int
    maxzoom: int


class Archive(NamedTuple):
    minzoom: int
    maxzoom: int
    layers: dict[str, list[Band]]
    description: str


def _single(path: str, lo: int, hi: int) -> list[Band]:
    return [Band((path,), lo, hi)]


def _split(coarse: str, fine: str, switch: int, lo: int, hi: int) -> list[Band]:
    """Coarse data below zoom ``switch``, fine data from it on."""
    return [Band((coarse,), lo, switch - 1), Band((fine,), switch, hi)]


BASIS = {
    "huisarts": "vector/vrz/basis/huisarts.shp",
    "ontmoeting": "vector/vrz/basis/ontmoeting.shp",
    "ovhalte": "vector/vrz/basis/ovhalte.shp",
    "supermarkt": "vector/vrz/basis/supermarkt.shp",
    "fysio": "vector/vrz/basis/fysiotherapie.shp",
    "ziekenhuis": "vector/vrz/basis/ziekenhuis.shp",
}
WOONZORG = {
    "wz": "woonzorg_locatie",
    "jz": "jeugdzorg_locatie",
    "vb": "locatie_voor_verstandelijk_gehandicapten",
    "zb": "locatie_voor_lichamelijk_gehandicapten",
    "re": "revalidatie",
    "mo": "maatschappelijke_opvang",
    "db": "dagbesteding",
    "bw": "beschermd_wonen",
    "ov": "overig",
}

# Building-level archives start at z8: the region is a few pixels across below it,
# and z0-7 tiles would each carry every building in Kennemerland.
PAND_MIN, PAND_MAX = 8, 16
# MapServer swapped to single buildings below 1:5000 (~z17) and to TOP10 blocks
# below 1:10000 (~z16). The archives stop at z16 (MapLibre overzooms beyond), so
# the building switch lands on z16 too — one zoom early, which only shows the
# detail slightly sooner.
PAND_SWITCH = 16
BLOK_SWITCH = 16

ARCHIVES: dict[str, Archive] = {
    "voorzieningen_basis": Archive(
        0, 14,
        {name: _single(path, 0, 14) for name, path in BASIS.items()},
        "KL basisvoorzieningen (locaties)",
    ),
    "voorzieningen_woonzorg_2025": Archive(
        0, 14,
        {code: _single(f"vector/2025/woonzorg/{stem}.shp", 0, 14) for code, stem in WOONZORG.items()},
        "KL zorgvastgoed 2025 (locaties)",
    ),
    "wijkteam": Archive(
        0, 14,
        {
            "haarlem": _single("vector/vrz/soc_wijkt_geb.shp", 0, 14),
            "velsen": _single("vector/vrz/soc_wijkt_vel.shp", 0, 14),
        },
        "KL verzorgingsgebieden sociale wijkteams",
    ),
    "woningpand_afstand": Archive(
        PAND_MIN, PAND_MAX,
        {"woningpand": _split("vector/woningpand_agg.shp", "vector/woningpand.shp",
                              PAND_SWITCH, PAND_MIN, PAND_MAX)},
        "KL loopafstand woonpand naar dichtstbijzijnde voorziening",
    ),
    "pand_vbo": Archive(
        PAND_MIN, PAND_MAX,
        {
            "pand_vbo": _split("vector/pand_vbo_agg.shp", "vector/pand_vbo.shp",
                               PAND_SWITCH, PAND_MIN, PAND_MAX),
            # Only the 2022 tables carry NR_VERD (verdiepingen) for hoog/laagbouw.
            "pand_vbo_2022": _split("vector/pand_vbo_agg_2022.shp", "vector/pand_vbo_2022.shp",
                                    PAND_SWITCH, PAND_MIN, PAND_MAX),
        },
        "KL panden met verblijfsobjecten (BAG)",
    ),
    "pand_overig": Archive(
        PAND_MIN, PAND_MAX,
        {
            "pand_corop": _single("vector/vastgoed/2024/pand_corop.shp", PAND_MIN, PAND_MAX),
            "pand_el": _single("vector/pand_el.shp", PAND_MIN, PAND_MAX),
        },
        "KL corporatie-eigenaar en energielabel per pand",
    ),
    "koophuur": Archive(
        PAND_MIN, PAND_MAX,
        {
            f"{kind}_{year}": _split(f"vector/vastgoed/{year}/{kind}_bbg.shp",
                                     f"vector/vastgoed/{year}/{kind}_top10.shp",
                                     BLOK_SWITCH, PAND_MIN, PAND_MAX)
            for kind in ("koop", "huur")
            for year in KOOPHUUR_YEARS
        },
        "KL aandeel koop- en huurwoningen 2022-2024",
    ),
    "wmo_buurt": Archive(
        0, 14,
        {"buurt": _single("vector/buurt.shp", 0, 14)},
        "KL WMO-cliënten per buurt (2020)",
    ),
    "wmo": Archive(
        0, 14,
        {
            f"{theme}_{year}": [
                Band((f"raster/{year}0101/wmo/{theme}_{res}.tif",), lo, hi)
                for res, (lo, hi) in WMO_BANDS.items()
            ]
            for theme, years in WMO_THEMES.items()
            for year in years
        },
        "KL WMO-cliënten, dichtheid per type zorg 2019-2025",
    ),
}


# --- helpers (as in build-wzw5-pmtiles.py) ------------------------------------

def log(message: str = "") -> None:
    print(message, flush=True)


def is_fresh(output: Path, inputs: list[Path]) -> bool:
    if not output.is_file():
        return False
    stamp = output.stat().st_mtime
    return all(p.stat().st_mtime <= stamp for p in inputs if p.is_file())


def run(command: list[str], what: str) -> str:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write((result.stdout or "")[-4000:])
        sys.stderr.write((result.stderr or "")[-4000:])
        raise SystemExit(f"error: {what} failed (exit {result.returncode})")
    return result.stdout or ""


def has_module(interpreter: list[str], module: str) -> bool:
    result = subprocess.run(interpreter + ["-c", f"import {module}"],
                            check=False, capture_output=True, text=True)
    return result.returncode == 0


def resolve_interpreters() -> tuple[list[str], list[str]]:
    """geopandas/rasterio and the GDAL bindings, rarely in one install."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for name in ("python-qgis.bat", "python3.exe", "python.exe"):
        found = shutil.which(name)
        if found and [found] not in candidates:
            candidates.append([found])
    vector = next((c for c in candidates if has_module(c, "geopandas")), None)
    tiles = next((c for c in candidates if has_module(c, "osgeo")), None)
    if vector is None:
        raise SystemExit("error: no interpreter with geopandas/rasterio found")
    if tiles is None:
        raise SystemExit("error: no interpreter with the GDAL bindings (osgeo) found")
    return vector, tiles


def has_classes(tif: Path) -> bool:
    """Whether a WMO raster holds any drawn class (1-7) at all."""
    import numpy as np
    import rasterio
    with rasterio.open(tif) as raster:
        cells = raster.read(1)
    return bool(np.any((cells >= 1) & (cells <= 7)))


def to_geojson(band_input: str, *, interpreter: list[str]) -> Path | None:
    """Convert one shapefile or raster to its cached WGS84 GeoJSON in WORK.

    None for a raster without a single classed cell. Those exist: where client
    numbers are small the old pipeline suppressed the pattern for privacy, and
    WMO_Dagbesteding is empty in most years. The band is then left out, and a
    year with no band at all gets no source layer — MapLibre draws nothing for
    a missing source layer, which is what the old map showed.
    """
    src = SRC / band_input
    if not src.is_file():
        raise SystemExit(f"error: source missing: {src}")
    if src.suffix.lower() != ".shp" and not has_classes(src):
        log(f"    {band_input}: no classed cells, skipped")
        return None
    out = (WORK / band_input).with_suffix(".geojson")
    if is_fresh(out, [src]):
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == ".shp":
        command = [str(SHP_TO_GEOJSON), str(src), "-o", str(out), "--assume-crs", ASSUME_CRS]
    else:
        command = [str(TIF_TO_GEOJSON), str(src), str(out), "--simplify", str(SIMPLIFY),
                   "--assign-crs", ASSUME_CRS, "--classes", "1,2,3,4,5,6,7"]
    log(f"    {band_input}")
    run(interpreter + command, f"converting {band_input}")
    return out


def build_archive(name: str, archive: Archive, *, vector: list[str], tiles: list[str]) -> Path:
    log(f"\n{name}")
    spec: dict[str, list[dict]] = {}
    for layer, bands in archive.layers.items():
        entries = []
        for band in bands:
            for band_input in band.inputs:
                path = to_geojson(band_input, interpreter=vector)
                if path is not None:
                    entries.append({"file": str(path), "minzoom": band.minzoom, "maxzoom": band.maxzoom})
        if entries:
            spec[layer] = entries

    out = PMTILES_OUT / f"{name}.pmtiles"
    out.parent.mkdir(parents=True, exist_ok=True)
    sources = [Path(e["file"]) for entries in spec.values() for e in entries]
    if is_fresh(out, sources):
        log(f"  reusing {out.name} ({out.stat().st_size:,} bytes)")
        return out
    for leftover in out.parent.glob(f"{out.name}.tmp.mbtiles*"):
        leftover.unlink()
    spec_path = WORK / f"{name}.spec.json"
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    log(f"  building {out.name}: {len(spec)} layer(s), {len(sources)} source(s)…")
    run(tiles + [
        str(GEOJSON_TO_PMTILES), "--spec", str(spec_path), "-o", str(out),
        "--minzoom", str(archive.minzoom), "--maxzoom", str(archive.maxzoom),
        "--max-size", str(MAX_SIZE), "--max-features", str(MAX_FEATURES),
        "--name", name, "--description", archive.description,
    ], out.name)
    log(f"  built {out.name} ({out.stat().st_size:,} bytes)")
    return out


def resolve_ssh_tool(name: str) -> str:
    if sys.platform == "win32":
        bundled = WINDOWS_OPENSSH / f"{name}.exe"
        if bundled.is_file():
            return str(bundled)
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"error: {name} not found on PATH — cannot upload")
    return found


def upload(files: list[Path], remote: str, identity: Path) -> None:
    """Stage on the host, then mv into place, so no half-written archive is served."""
    ssh, scp = resolve_ssh_tool("ssh"), resolve_ssh_tool("scp")
    key = ["-i", str(identity)] if identity.is_file() else []
    host, _, path = remote.partition(":")
    path = path.rstrip("/")
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    def remote_sh(script: str, check: bool = True) -> None:
        result = subprocess.run([ssh, *key, host, script], check=False, text=True)
        if check and result.returncode != 0:
            raise SystemExit(f"error: remote command failed (exit {result.returncode})")

    log(f"\nUploading {len(files)} archive(s), {sum(p.stat().st_size for p in files):,} bytes -> {remote}")
    remote_sh(f"mkdir -p '{staging}'")
    try:
        result = subprocess.run([scp, *key, *(str(p) for p in files), f"{host}:{staging}/"], check=False)
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")
        remote_sh(f"chmod a+r '{staging}'/*.pmtiles && mv '{staging}'/*.pmtiles '{path}/' && rmdir '{staging}'")
    except BaseException:
        remote_sh(f"rm -rf '{staging}'", check=False)
        raise
    remote_sh("stat -c '%s  %n' " + " ".join(f"'{path}/{p.name}'" for p in files))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", action="append", choices=sorted(ARCHIVES), default=[],
                        help="Build just this archive (repeatable)")
    parser.add_argument("--upload", action="store_true", help="Publish the archives afterwards")
    parser.add_argument("--remote", default=DEFAULT_REMOTE)
    parser.add_argument("--identity", type=Path, default=DEFAULT_IDENTITY)
    args = parser.parse_args(argv[1:])

    if not SRC.is_dir():
        raise SystemExit(f"error: {SRC} missing — fetch the sources first (see the docstring)")
    vector, tiles = resolve_interpreters()
    names = args.only or list(ARCHIVES)
    built = [build_archive(n, ARCHIVES[n], vector=vector, tiles=tiles) for n in names]
    if args.upload:
        upload(built, args.remote, args.identity)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
