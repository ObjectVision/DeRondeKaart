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
"""Build the WoonZorgWijzer 5 hoofdgroep PMTiles — one archive per hoofdgroep.

``WZW5_EXPORT/wzw5_hg_all/hg_<code>/`` holds, per hoofdgroep, the same classified
raster for **12 years (2018-2029)** at **three resolutions** (``yr_<year>_m5.tif``,
``_m10``, ``_m20``) on the national grid. Each is a uint8 class raster (classes
1-7, nodata 255 by convention) in EPSG:28992.

This driver turns each hoofdgroep into ONE archive carrying one vector tile layer
per year, so the app animates it with the timeseries slider it already has:

    hg_dem/yr_2018_m20.tif ─┐
    hg_dem/yr_2018_m10.tif ─┼─> source-layer "HGDEM_2018"  (3 zoom bands)
    hg_dem/yr_2018_m5.tif  ─┘
    …                           -> pmtiles/woonzorgwijzer/HGDEM.pmtiles

**Three resolutions, one layer, banded by zoom.** A 20 m cell is sub-pixel below
z13 and a 5 m cell below z15, so shipping only m5 would send ~16x the geometry for
detail no one can see when zoomed out. Each year's layer therefore draws m20 up to
z11, m10 at z12-13 and m5 at z14 (MapLibre overzooms past the archive's maxzoom, so
z14 also serves deeper). The bands are mutually exclusive, which is what
``convert-geojson-to-pmtiles.py --spec`` requires — no ``--allow-overlapping-bands``.

**The mask.** The rasters are national but only seven WZW regions are licensed for
publication. ``WoonzorgWijzer/cfg/stam/brondata.dms`` selects them:

    container WZW5_public := WZW5_to_vectortile_input("WZWGelderland\\nWZWNoordHolland\\n…");

and ``cfg/stam/geografie.dms`` defines each as a set of GM_CODEs — three as province
selections, four as literal lists. Resolved here against
``cbsgebiedsindelingen2025.gpkg`` to **232 of 342 gemeenten (59.3% of NL)** and the
polygons are clipped to it. GeoDMS derives its ``prov_naam`` by a spatial relation,
which is replicated with a representative-point spatial join (all 342 resolve).

Steps, each cached — a step is skipped when its output is newer than its inputs, so
an interrupted run resumes:

1. ``convert-tif-to-geojson.py`` per raster (288 of them: 8 x 12 x 3).
2. Clip to the mask (``geopandas.clip``), writing ``<stem>.clip.geojson``.
3. ``convert-geojson-to-pmtiles.py --spec`` per hoofdgroep, 36 banded sources.

The two converters need **different interpreters** and the script finds them itself:
vectorising needs geopandas/rasterio (pip), the PMTiles step needs the GDAL bindings,
which on Windows come from OSGeo4W and not from pip. See ``build-years-pmtiles.py``,
whose ``resolve_interpreters`` this mirrors.

With ``--upload`` the archives go to the data host behind
``https://data.derondekaart.nl/pmtiles/woonzorgwijzer/`` — staged first and moved into
place, as in ``build-bereikbaarheid-pmtiles.py``.

Usage:
    # Everything: 288 rasters -> 8 archives (hours; resumable)
    python3 build-wzw5-pmtiles.py

    # One hoofdgroep, to check the pipeline end to end first:
    python3 build-wzw5-pmtiles.py --only dem

    # A couple of years while iterating on style:
    python3 build-wzw5-pmtiles.py --only dem --years 2018,2024

    # Build and publish:
    python3 build-wzw5-pmtiles.py --upload
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Source rasters and the GeoDMS project that defines the mask.
WZW5_EXPORT = Path(r"C:\Users\Cicada\prj\WZW5_export")
TIF_ROOT = WZW5_EXPORT / "wzw5_hg_all"
CBS_GPKG = Path(r"C:\SourceData\CBS\2025\cbsgebiedsindelingen2025.gpkg")
GEMEENTE_LAYER = "gemeente_gegeneraliseerd"
PROVINCIE_LAYER = "provincie_gegeneraliseerd"

WORK = HERE / "wzw5" / "work"
PMTILES_OUT = HERE / "pmtiles" / "woonzorgwijzer"

TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

# Where OSGeo4W puts its interpreter on Windows. Only a fallback, for the GDAL
# bindings the PMTiles step needs.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

# The data host behind https://data.derondekaart.nl/pmtiles/.
DEFAULT_REMOTE = "objectvision@37.97.226.58:/var/www/objectvision_data/pmtiles/woonzorgwijzer"
DEFAULT_IDENTITY = Path.home() / ".ssh" / "id_ed25519_transip"

# Windows ships OpenSSH here; preferred over the Git-for-Windows build, which
# cannot talk to the Windows ssh-agent.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

# Hoofdgroep: source folder -> archive / source-layer prefix. The prefixes are
# MapGallery's own (`layername` of layers 342-349, minus the _v3 suffix), so the
# two systems name the same data the same way.
HOOFDGROEPEN = {
    "dem": "HGDEM",
    "lvb": "HGLVB",
    "vg": "HGVG",
    "som": "HGSOM",
    "zin": "HGZIN",
    "psy1": "HGPSY1",
    "psy2": "HGPSY2",
    "jgd": "HGJGD",
}

DEFAULT_YEARS = tuple(str(y) for y in range(2018, 2030))

# Resolution -> zoom band. A 20 m cell is ~1.7 px at z13 and a 5 m cell ~0.85 px
# at z14, so each grid takes over where it starts to carry visible detail. The
# bands must not overlap: the converter rejects that unless told otherwise.
RESOLUTION_BANDS = {
    "m20": (0, 11),
    "m10": (12, 13),
    "m5": (14, 14),
}
MINZOOM = 0
MAXZOOM = 14

# Tiles of national class polygons run large; the bereikbaarheid archives use the
# same ceiling rather than GDAL's 500 kB default, which silently drops features.
MAX_SIZE = 2_000_000

# Matches the validated default of convert-tif-to-geojson.py.
DEFAULT_SIMPLIFY = 10.0

# --- the WZW5 publication mask --------------------------------------------
#
# From WoonzorgWijzer/cfg/stam/geografie.dms (container WZW5GemeenteCodes). The
# four literal lists are transcribed verbatim; the three province selections are
# resolved against the gpkg because GM_CODEs change between years and a province
# is the stable definition.
#
# WZWGelderland is a hand-picked 56-gemeente subset, NOT the whole province.
WZW_CODE_LISTS = {
    "WZWGelderland": [
        "GM0150", "GM0197", "GM0200", "GM0202", "GM0203", "GM0209", "GM0213", "GM0214",
        "GM0216", "GM0221", "GM0222", "GM0225", "GM0226", "GM0228", "GM0230", "GM0232",
        "GM0233", "GM0243", "GM0244", "GM0246", "GM0252", "GM0262", "GM0263", "GM0267",
        "GM0268", "GM0269", "GM0273", "GM0274", "GM0275", "GM0277", "GM0279", "GM0281",
        "GM0285", "GM0289", "GM0293", "GM0294", "GM0296", "GM0297", "GM0299", "GM0301",
        "GM0302", "GM0339", "GM0340", "GM0345", "GM0668", "GM0944", "GM1509", "GM1586",
        "GM1705", "GM1734", "GM1740", "GM1859", "GM1876", "GM1945", "GM1955", "GM1960",
    ],
    "WZWZeeland": [
        "GM1676", "GM0716", "GM1695", "GM0717", "GM0718", "GM0687", "GM0664", "GM0654",
        "GM0678", "GM0703", "GM1714", "GM0715", "GM0677",
    ],
    # GM1731 appears twice in the .dms list (nrofrows=13, 12 distinct).
    "WZWDrenthe": [
        "GM1699", "GM1730", "GM0106", "GM1680", "GM1731", "GM1681", "GM1701", "GM0119",
        "GM1690", "GM0118", "GM0109", "GM0114",
    ],
    "WZWHengelo": ["GM0164"],
}

# select_with_org_rel(… /prov_naam == "<name>") in geografie.dms.
WZW_PROVINCES = {
    "WZWNoordHolland": "Noord-Holland",
    "WZWZuidHolland": "Zuid-Holland",
    "WZWNoordBrabant": "Noord-Brabant",
}

MASK_GEOJSON = WORK / "wzw5_mask.geojson"


def log(message: str = "") -> None:
    print(message, flush=True)


def is_fresh(output: Path, inputs: list[Path]) -> bool:
    """Whether ``output`` exists and is newer than every input."""
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
    """Whether ``interpreter`` can import ``module``."""
    result = subprocess.run(
        interpreter + ["-c", f"import {module}"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def resolve_interpreters(*, need_pmtiles: bool) -> tuple[list[str], list[str] | None]:
    """Find an interpreter for each stage, which are rarely the same one.

    Mirrors build-years-pmtiles.py: geopandas/rasterio come from pip, the GDAL
    bindings from OSGeo4W, and neither install tends to have both.
    """
    current = [sys.executable]
    candidates = [current]

    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for name in ("python-qgis.bat", "python3.exe", "python.exe"):
        found = shutil.which(name)
        if found and [found] not in candidates:
            candidates.append([found])

    vector_python = next((c for c in candidates if has_module(c, "geopandas")), None)
    if vector_python is None:
        raise SystemExit(
            "error: no interpreter found with geopandas/rasterio installed.\n"
            "  install:  pip install geopandas rasterio shapely pyogrio"
        )
    log(f"Vectorising with:  {Path(vector_python[0]).name}")

    if not need_pmtiles:
        return vector_python, None

    pmtiles_python = next((c for c in candidates if has_module(c, "osgeo")), None)
    if pmtiles_python is None:
        raise SystemExit(
            "error: no interpreter found with the GDAL bindings (osgeo), which\n"
            "       the PMTiles step needs.\n"
            f"  Windows/OSGeo4W:  expected {OSGEO4W_PYTHON}\n"
            "  Pass --no-pmtiles to stop after vectorising."
        )
    log(f"PMTiles with:      {Path(pmtiles_python[0]).name}")
    return vector_python, pmtiles_python


def build_mask() -> Path:
    """Resolve the WZW5 publication mask to one dissolved polygon, cached on disk."""
    if is_fresh(MASK_GEOJSON, [CBS_GPKG]):
        log(f"Mask       reusing {MASK_GEOJSON.name}")
        return MASK_GEOJSON

    import geopandas as gpd

    if not CBS_GPKG.is_file():
        raise SystemExit(f"error: CBS gebiedsindelingen not found: {CBS_GPKG}")

    log(f"Mask       resolving from {CBS_GPKG.name}…")
    gem = gpd.read_file(CBS_GPKG, layer=GEMEENTE_LAYER)
    prov = gpd.read_file(CBS_GPKG, layer=PROVINCIE_LAYER)[["statnaam", "geometry"]]
    prov = prov.rename(columns={"statnaam": "prov"})

    # GeoDMS reads prov_naam off a spatial relation; the gpkg has no such column.
    # A representative point is used rather than a centroid: for a concave or
    # multipart gemeente the centroid can fall outside its own polygon.
    reps = gpd.GeoDataFrame(
        gem[["statcode"]].copy(), geometry=gem.representative_point(), crs=gem.crs
    )
    joined = gpd.sjoin(reps, prov, how="left", predicate="within")
    gem["prov"] = joined["prov"].values
    unassigned = int(gem["prov"].isna().sum())
    if unassigned:
        log(f"  warning: {unassigned} gemeente(n) matched no province")

    codes: set[str] = set()
    known = set(gem["statcode"])
    for name, listed in WZW_CODE_LISTS.items():
        have = known & set(listed)
        missing = sorted(set(listed) - have)
        if missing:
            # Not fatal: a code retired since the .dms was written just drops out.
            log(f"  warning: {name}: {len(missing)} code(s) not in {GEMEENTE_LAYER}: {missing}")
        log(f"  {name:<16} {len(have):>3} gemeente(n)")
        codes |= have
    for name, province in WZW_PROVINCES.items():
        selected = set(gem.loc[gem["prov"] == province, "statcode"])
        if not selected:
            raise SystemExit(f"error: {name}: no gemeenten found for province {province!r}")
        log(f"  {name:<16} {len(selected):>3} gemeente(n)  (prov {province})")
        codes |= selected

    mask = gem[gem["statcode"].isin(codes)].dissolve()[["geometry"]]
    area = float(mask.area.sum()) / 1e6
    total = float(gem.dissolve().area.sum()) / 1e6
    log(
        f"  mask: {len(codes)} of {len(gem)} gemeenten, "
        f"{area:,.0f} km2 of {total:,.0f} km2 ({100 * area / total:.1f}% of NL)"
    )

    MASK_GEOJSON.parent.mkdir(parents=True, exist_ok=True)
    # Kept in RD (EPSG:28992) — clipping happens in the polygons' own CRS, which
    # convert-tif-to-geojson.py writes as WGS84, so this is reprojected per use.
    mask.to_file(MASK_GEOJSON, driver="GeoJSON")
    log(f"  wrote {MASK_GEOJSON.name} ({MASK_GEOJSON.stat().st_size:,} bytes)")
    return MASK_GEOJSON


def source_tif(folder: str, year: str, resolution: str) -> Path:
    return TIF_ROOT / f"hg_{folder}" / f"yr_{year}_{resolution}.tif"


def vectorize(tif: Path, out: Path, *, interpreter: list[str], simplify: float) -> None:
    """Polygonise one classified raster into GeoJSON."""
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        interpreter
        + [str(TIF_TO_GEOJSON), str(tif), str(out), "--simplify", str(simplify)],
        f"vectorising {tif.name}",
    )


def clip_to_mask(raw: Path, out: Path, mask_path: Path) -> int:
    """Clip polygons to the publication mask. Returns the feature count kept."""
    import geopandas as gpd

    polygons = gpd.read_file(raw)
    mask = gpd.read_file(mask_path).to_crs(polygons.crs)
    clipped = gpd.clip(polygons, mask.geometry.iloc[0])
    # clip can leave slivers of the wrong dimension where an edge grazes the mask.
    clipped = clipped[~clipped.geometry.is_empty & clipped.geometry.notna()]
    clipped = clipped[clipped.geometry.geom_type.isin(("Polygon", "MultiPolygon"))]
    clipped.to_file(out, driver="GeoJSON")
    return len(clipped)


def prepare(
    folders: list[str],
    years: list[str],
    *,
    interpreter: list[str],
    simplify: float,
    mask_path: Path,
    keep_raw: bool,
) -> dict[str, dict[str, dict[str, Path]]]:
    """Vectorise and clip every raster. Returns {folder: {year: {resolution: path}}}."""
    todo = [
        (folder, year, resolution)
        for folder in folders
        for year in years
        for resolution in RESOLUTION_BANDS
    ]
    results: dict[str, dict[str, dict[str, Path]]] = {}
    total = len(todo)
    log(f"\nVectorising {total} raster(s)…")

    for index, (folder, year, resolution) in enumerate(todo, start=1):
        tif = source_tif(folder, year, resolution)
        if not tif.is_file():
            raise SystemExit(f"error: raster not found: {tif}")

        stem = f"{HOOFDGROEPEN[folder]}_{year}_{resolution}"
        raw = WORK / folder / f"{stem}.raw.geojson"
        clipped = WORK / folder / f"{stem}.geojson"
        prefix = f"[{index}/{total}] {stem}"

        if is_fresh(clipped, [tif, mask_path]):
            log(f"{prefix}  reusing ({clipped.stat().st_size:,} bytes)")
        else:
            started = time.time()
            if not is_fresh(raw, [tif]):
                vectorize(tif, raw, interpreter=interpreter, simplify=simplify)
            kept = clip_to_mask(raw, clipped, mask_path)
            log(
                f"{prefix}  {kept:,} feature(s), "
                f"{clipped.stat().st_size:,} bytes, {time.time() - started:.0f}s"
            )
            if not keep_raw:
                raw.unlink(missing_ok=True)

        results.setdefault(folder, {}).setdefault(year, {})[resolution] = clipped

    return results


def archive_spec(folder: str, per_year: dict[str, dict[str, Path]]) -> dict:
    """One source-layer per year, each with the three resolutions as zoom bands."""
    prefix = HOOFDGROEPEN[folder]
    spec: dict[str, list[dict]] = {}
    for year in sorted(per_year):
        bands = []
        for resolution, (lo, hi) in RESOLUTION_BANDS.items():
            path = per_year[year].get(resolution)
            if path is None:
                continue
            bands.append({"file": str(path), "minzoom": lo, "maxzoom": hi})
        spec[f"{prefix}_{year}"] = bands
    return spec


def build_archive(
    folder: str,
    per_year: dict[str, dict[str, Path]],
    *,
    interpreter: list[str],
) -> Path:
    """Run convert-geojson-to-pmtiles.py over one hoofdgroep's banded sources."""
    prefix = HOOFDGROEPEN[folder]
    out = PMTILES_OUT / f"{prefix}.pmtiles"
    out.parent.mkdir(parents=True, exist_ok=True)

    spec = archive_spec(folder, per_year)
    sources = [Path(band["file"]) for bands in spec.values() for band in bands]
    if is_fresh(out, sources):
        log(f"  {prefix:<8} reusing {out.name} ({out.stat().st_size:,} bytes)")
        return out

    spec_path = WORK / folder / f"{prefix}.spec.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")

    log(f"  {prefix:<8} building {out.name} from {len(spec)} year(s), {len(sources)} source(s)…")
    run(
        interpreter
        + [
            str(GEOJSON_TO_PMTILES),
            "--spec", str(spec_path),
            "-o", str(out),
            "--minzoom", str(MINZOOM),
            "--maxzoom", str(MAXZOOM),
            "--max-size", str(MAX_SIZE),
            "--name", prefix,
            "--description", f"WoonZorgWijzer 5 hoofdgroep {prefix} {min(spec)[-4:]}-{max(spec)[-4:]}",
        ],
        f"{out.name}",
    )
    log(f"  {prefix:<8} built    {out.name} ({out.stat().st_size:,} bytes)")
    return out


# --- upload ----------------------------------------------------------------

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
    """Copy archives to the data host via a staging folder, then mv into place.

    scp writes straight into the destination file, so copying over a live archive
    would serve a half-written one; staging and moving makes it atomic.
    """
    ssh = resolve_ssh_tool("ssh")
    scp = resolve_ssh_tool("scp")
    key = ["-i", str(identity)] if identity.is_file() else []
    if not key:
        log(f"warning: identity {identity} not found — relying on ssh-agent/config")
    host, sep, path = remote.partition(":")
    if not sep or not path:
        raise SystemExit(f"error: --remote must look like user@host:/path, got {remote!r}")
    path = path.rstrip("/")
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    def remote_sh(script: str, check: bool = True) -> None:
        result = subprocess.run([ssh, *key, host, script], check=False, text=True)
        if check and result.returncode != 0:
            raise SystemExit(f"error: remote command failed (exit {result.returncode})")

    total = sum(p.stat().st_size for p in files)
    log(f"\nUploading {len(files)} archive(s), {total:,} bytes -> {remote}")
    remote_sh(f"mkdir -p '{staging}'")
    try:
        result = subprocess.run(
            [scp, *key, *(str(p) for p in files), f"{host}:{staging}/"], check=False
        )
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")
        remote_sh(f"mkdir -p '{path}' && mv '{staging}'/*.pmtiles '{path}/' && rmdir '{staging}'")
    except BaseException:
        remote_sh(f"rm -rf '{staging}'", check=False)
        raise
    log("Upload done. Remote sizes:")
    remote_sh("stat -c '%s  %n' " + " ".join(f"'{path}/{p.name}'" for p in files))


def parse_years(value: str) -> list[str]:
    years = [part.strip() for part in value.split(",") if part.strip()]
    if not years:
        raise argparse.ArgumentTypeError("--years given but no values parsed")
    for year in years:
        if not year.isdigit():
            raise argparse.ArgumentTypeError(f"--years expects numeric years, got {year!r}")
    return years


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build one PMTiles archive per WZW5 hoofdgroep, with one source-layer "
            "per year and m20/m10/m5 banded by zoom, clipped to the WZW5 mask."
        ),
    )
    parser.add_argument(
        "--only",
        action="append",
        metavar="dem",
        help=(
            "Hoofdgroep to build (repeatable; default: all). One of: "
            + ", ".join(HOOFDGROEPEN)
        ),
    )
    parser.add_argument(
        "--years",
        type=parse_years,
        default=list(DEFAULT_YEARS),
        metavar="2018,2024",
        help=f"Years to include (default: {DEFAULT_YEARS[0]}-{DEFAULT_YEARS[-1]})",
    )
    parser.add_argument(
        "--simplify",
        type=float,
        default=DEFAULT_SIMPLIFY,
        metavar="PCT",
        help=f"Vertices to keep when vectorising (default: {DEFAULT_SIMPLIFY:g})",
    )
    parser.add_argument(
        "--keep-raw",
        action="store_true",
        help="Keep the unclipped GeoJSONs (large; useful when changing the mask)",
    )
    parser.add_argument(
        "--no-pmtiles",
        dest="build",
        action="store_false",
        help="Only vectorise and clip; stop before building the archives",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Copy the finished archives to the data host",
    )
    parser.add_argument("--remote", default=DEFAULT_REMOTE, help=f"default: {DEFAULT_REMOTE}")
    parser.add_argument(
        "--identity",
        type=Path,
        default=DEFAULT_IDENTITY,
        help=f"ssh private key (default: {DEFAULT_IDENTITY})",
    )
    args = parser.parse_args(argv[1:])

    for script in (TIF_TO_GEOJSON, GEOJSON_TO_PMTILES):
        if not script.is_file():
            print(f"error: missing sibling script: {script}", file=sys.stderr)
            return 2
    if not TIF_ROOT.is_dir():
        print(f"error: raster root not found: {TIF_ROOT}", file=sys.stderr)
        return 2

    if args.only:
        unknown = [name for name in args.only if name not in HOOFDGROEPEN]
        if unknown:
            print(
                f"error: unknown hoofdgroep(en) {unknown}; expected one of "
                f"{list(HOOFDGROEPEN)}",
                file=sys.stderr,
            )
            return 2
        folders = [name for name in HOOFDGROEPEN if name in set(args.only)]
    else:
        folders = list(HOOFDGROEPEN)

    started = time.time()
    vector_python, pmtiles_python = resolve_interpreters(need_pmtiles=args.build)

    log(
        f"\n{len(folders)} hoofdgroep(en) x {len(args.years)} year(s) x "
        f"{len(RESOLUTION_BANDS)} resolution(s)"
    )
    for resolution, (lo, hi) in RESOLUTION_BANDS.items():
        log(f"  {resolution:<4} z{lo}-{hi}")

    mask_path = build_mask()
    prepared = prepare(
        folders,
        args.years,
        interpreter=vector_python,
        simplify=args.simplify,
        mask_path=mask_path,
        keep_raw=args.keep_raw,
    )

    archives: list[Path] = []
    if args.build:
        log("\nPMTiles")
        for folder in folders:
            archives.append(
                build_archive(folder, prepared[folder], interpreter=pmtiles_python)
            )

    if args.upload:
        if not archives:
            print("error: --upload with nothing built (--no-pmtiles?)", file=sys.stderr)
            return 2
        upload(archives, args.remote, args.identity)

    elapsed = time.time() - started
    log(f"\nDone in {elapsed / 60:.0f}m — {len(archives)} archive(s)")
    for path in archives:
        log(f"  {path.name:<16} {path.stat().st_size:>14,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
