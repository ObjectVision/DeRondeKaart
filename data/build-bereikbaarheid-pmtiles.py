#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "geopandas>=1.0",
#   "shapely>=2.0",
# ]
# ///
"""Build the "Elke Regio Telt" (bereikbaarheid_bzk) PMTiles from the MapServer data.

The old MapServer setup in ``bereikbaarheid/bereikbaarheid_bzk/`` serves one
region at a time (``&data=<region>``): per theme a 10 m class GRID shown when
zoomed out (``grid/<region>/<CODE>_m10.tif``, MINSCALE 15000) and a top10nl
VECTOR layer shown when zoomed in (``vector/<region>/<CODE>_m5.shp``, MAXSCALE
15000). This driver merges the twelve regions and both halves into ONE archive
per theme:

    pmtiles/bereikbaarheid_bzk/ber_<THEME>.pmtiles
        source-layer "afstand":  grid polygons  z5-12  (12 regions)
                                 top10nl vectors z13-14 (12 regions)

1:15 000 is about MapLibre zoom 13.5 at 52° N, hence the z12/z13 split. Both
bands carry the same ``score`` (1-8, the distance class) and a ``label`` with
the featureinfo text of the old ``templates/score.html``, so one style and one
popup serve every zoom. The regions' data do not overlap, which is why the
bands are declared with ``--allow-overlapping-bands``: the twelve sources of
one band touch different tiles, not the same ones.

Two more archives:

    ber_gebieden_2022.pmtiles  gemeente / woonplaats / wijk / buurt (2022)
    ber_studiegebied.pmtiles   the mask: id 1 = veil with the 12 regions as
                               holes, id 2 = the regions' outline

Steps, each cached (a step is skipped when its output is newer than its inputs):

1. ``convert-tif-to-geojson.py`` per grid (the TIFs have only a ``.tfw``, so
   ``--assign-crs EPSG:28992``), then ``class`` -> ``score`` and ``label``.
2. ``convert-shapefile-to-geojson.py`` per theme, merging the 12 regions.
3. ``convert-geojson-to-pmtiles.py --spec`` per archive.

Needs the GDAL Python bindings (``osgeo``) in the current interpreter, and
mapshaper through ``npx`` (see ``convert-tif-to-geojson.py``).

With ``--upload`` the archives go to the data host behind
``https://data.derondekaart.nl/pmtiles/bereikbaarheid_bzk/`` — staged first and
moved into place, as in ``build-startanalyse-pmtiles.py``.

Usage:
    python3 build-bereikbaarheid-pmtiles.py
    python3 build-bereikbaarheid-pmtiles.py --only APOTHEEK --only gebieden
    python3 build-bereikbaarheid-pmtiles.py --upload
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "bereikbaarheid" / "bereikbaarheid_bzk"
MASK_DIR = HERE / "bereikbaarheid" / "bereikbaarheid" / "mask"
WORK = HERE / "bereikbaarheid" / "work"
PMTILES_OUT = HERE / "pmtiles" / "bereikbaarheid_bzk"

TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
SHP_TO_GEOJSON = HERE / "convert-shapefile-to-geojson.py"
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

# The data host behind https://data.derondekaart.nl/pmtiles/.
DEFAULT_REMOTE = "objectvision@37.97.226.58:/var/www/objectvision_data/pmtiles/bereikbaarheid_bzk"
DEFAULT_IDENTITY = Path.home() / ".ssh" / "ovsrv06_id_ed25519"

# Windows ships OpenSSH here; preferred over the Git-for-Windows build.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

# The twelve "Elke Regio Telt" regions (gallery maps 1-12). parkstad and
# veenkolonie also exist in grid/ and vector/ but are not part of the map.
REGIONS = {
    "twente": "mask_twente",
    "kopnoordholland": "mask_kopnoordholland",
    "zeeuwsvlaanderen": "mask_zeeuwsvlaanderen",
    "zuidlimburg": "mask_zuidlimburg",
    "zuidoostdrenthe": "mask_zuidoostdrenthe",
    "oostgroningen": "mask_oostgroningen",
    "noordgroningen": "mask_noordgroningen",
    "noordfriesland": "mask_noordfriesland",
    "zuidoostfriesland": "mask_zuidoostfriesland",
    "middenlimburg": "mask_middenlimbug",  # sic, as on disk
    "noordlimburg": "mask_noordlimbug",  # sic, as on disk
    "achterhoek": "mask_achterhoek",
}

# Theme (mapfile group ber_<THEME>) -> file code, from the mapfiles' DATA lines.
# OVHALTE reads OV_*, not the OVHALTE_* grid that twente also has.
THEMES = {
    "BASISOND": "BO",
    "VMBO": "VMBO",
    "HAVOVWO": "HAVW",
    "VO": "VO",
    "KDV": "KDV",
    "BSO": "BSO",
    "HUISARTS": "HUIS",
    "HARTSPOST": "HPOST",
    "APOTHEEK": "APO",
    "ZIEKENHUIS": "ZKH",
    "BIBLIO": "BIB",
    "ONTMOETING": "ONT",
    "ZWEMBAD": "ZWEM",
    "MUSEUM": "MUS",
    "PODIUM": "POD",
    "BIOSCOOP": "BIOS",
    "GRSUPERM": "GRSU",
    "OVDAGLEV": "DAGL",
    "WINKELCENTRUM": "WC",
    "WARENH": "WAR",
    "TREINST": "TREIN",
    "OVERSTAPST": "OVER",
    "OVHALTE": "OV",
    "OPRITH": "OPRIT",
    "CAFE": "CAFE",
    "CAFETARIA": "CATA",
    "RESTAURANT": "REST",
    "HOTEL": "HOT",
}

# Featureinfo text per distance class, from templates/score.html.
LABELS = {
    1: "0 tot 200 meter (naast de deur)",
    2: "200 .. 400 meter (vaak gebruikte OV norm)",
    3: "400 .. 1.000 meter (CBS-grens voor loopafstand)",
    4: "1 .. 2.5 kilometer (tot ca. 10 minuten rustig fietsen)",
    5: "2.5 .. 5 kilometer (tot ca. 20 min. rustig fietsen)",
    6: "5 .. 10 kilometer (tot ca. 15 minuten met de auto)",
    7: "10 .. 20 kilometer (tot ca. half uur met de auto)",
    8: "20 km of meer",
}

# Gebiedsindelingen: source-layer -> shapefile stem in vector/<region>/2022/.
GEBIEDEN = {"gemeente": "gem", "woonplaats": "woonplaats", "wijk": "wijk", "buurt": "buurt"}

GRID_BAND = (5, 12)
VECTOR_BAND = (13, 14)
MAX_SIZE = 2_000_000

# Outer edge of the mask veil, in WGS84: comfortably around the Netherlands.
VEIL_BOUNDS = (1.0, 49.5, 9.5, 55.0)


def is_fresh(output: Path, inputs: list[Path]) -> bool:
    """Whether ``output`` exists and is newer than every input."""
    if not output.is_file():
        return False
    stamp = output.stat().st_mtime
    return all(p.stat().st_mtime <= stamp for p in inputs)


def run(command: list[str], what: str) -> None:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout[-4000:] + result.stderr[-4000:])
        raise SystemExit(f"error: {what} failed (exit {result.returncode})")


def label_features(path: Path, rename_class: bool) -> None:
    """Give every feature ``score`` (renamed from ``class``) and ``label``."""
    data = json.loads(path.read_text(encoding="utf-8"))
    for feature in data["features"]:
        props = feature.setdefault("properties", {})
        if rename_class and "class" in props:
            props["score"] = props.pop("class")
        props["label"] = LABELS.get(props.get("score"), "")
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


# --- step 1: grids ---------------------------------------------------------

def grid_geojson(theme: str, region: str) -> Path:
    code = THEMES[theme]
    tif = SRC / "grid" / region / f"{code}_m10.tif"
    out = WORK / "grid" / theme / f"{region}.geojson"
    if is_fresh(out, [tif, TIF_TO_GEOJSON]):
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [sys.executable, str(TIF_TO_GEOJSON), str(tif), str(out), "--assign-crs", "EPSG:28992"],
        f"{theme}/{region} grid",
    )
    label_features(out, rename_class=True)
    print(f"  grid   {theme:<14} {region:<18} {out.stat().st_size:>12,} bytes", flush=True)
    return out


# --- step 2: vectors -------------------------------------------------------

def vector_geojson(theme: str) -> Path:
    code = THEMES[theme]
    shps = [SRC / "vector" / region / f"{code}_m5.shp" for region in REGIONS]
    out = WORK / "vector" / f"{theme}.geojson"
    if is_fresh(out, shps + [SHP_TO_GEOJSON]):
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [sys.executable, str(SHP_TO_GEOJSON), *map(str, shps), "-o", str(out),
         "--where", "score > 0"],
        f"{theme} vector",
    )
    label_features(out, rename_class=False)
    print(f"  vector {theme:<14} {'(12 regions)':<18} {out.stat().st_size:>12,} bytes", flush=True)
    return out


def gebied_geojson(level: str) -> Path:
    stem = GEBIEDEN[level]
    shps = [SRC / "vector" / region / "2022" / f"{stem}.shp" for region in REGIONS]
    out = WORK / "gebieden" / f"{level}.geojson"
    if is_fresh(out, shps + [SHP_TO_GEOJSON]):
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    run([sys.executable, str(SHP_TO_GEOJSON), *map(str, shps), "-o", str(out)], f"{level} gebied")
    print(f"  gebied {level:<14} {out.stat().st_size:>31,} bytes", flush=True)
    return out


def studyarea_geojson() -> Path:
    """Mask: id 1 = veil with the regions as holes, id 2 = the regions."""
    import geopandas as gpd
    from shapely.geometry import box
    from shapely.ops import unary_union

    masks = [MASK_DIR / f"{name}.geojson" for name in REGIONS.values()]
    out = WORK / "studiegebied.geojson"
    if is_fresh(out, masks):
        return out

    outlines = []
    for path in masks:
        gdf = gpd.read_file(path)
        # The masks are in RD New without a crs member; GDAL reads them as WGS84.
        gdf = gdf.set_crs("EPSG:28992", allow_override=True)
        outlines.append(gdf[gdf["id"] == 2].to_crs("EPSG:4326").geometry.union_all())
    regions = unary_union(outlines)
    veil = box(*VEIL_BOUNDS).difference(regions)

    gdf = gpd.GeoDataFrame({"id": [1, 2]}, geometry=[veil, regions], crs="EPSG:4326")
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    print(f"  mask   {len(masks)} regions -> {out.name}", flush=True)
    return out


# --- step 3: pmtiles -------------------------------------------------------

def build_pmtiles(name: str, spec: dict, minzoom: int, maxzoom: int, overlapping: bool) -> Path:
    out = PMTILES_OUT / f"{name}.pmtiles"
    inputs = [Path(s["file"]) for sources in spec.values() for s in sources]
    if is_fresh(out, inputs):
        print(f"  reusing {out.name}")
        return out
    spec_path = WORK / "specs" / f"{name}.json"
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    command = [
        sys.executable, str(GEOJSON_TO_PMTILES), "--spec", str(spec_path), "-o", str(out),
        "--minzoom", str(minzoom), "--maxzoom", str(maxzoom), "--max-size", str(MAX_SIZE),
    ]
    if overlapping:
        command.append("--allow-overlapping-bands")
    run(command, f"{name}.pmtiles")
    print(f"  built  {out.name:<32} {out.stat().st_size:>14,} bytes", flush=True)
    return out


def theme_spec(theme: str, grids: list[Path], vector: Path) -> dict:
    lo, hi = GRID_BAND
    vlo, vhi = VECTOR_BAND
    return {
        "afstand": [{"file": str(p), "minzoom": lo, "maxzoom": hi} for p in grids]
        + [{"file": str(vector), "minzoom": vlo, "maxzoom": vhi}]
    }


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
    """Copy archives to the data host via a staging folder, then mv into place."""
    ssh = resolve_ssh_tool("ssh")
    scp = resolve_ssh_tool("scp")
    key = ["-i", str(identity)] if identity.is_file() else []
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
    print(f"\nUploading {len(files)} archive(s), {total:,} bytes -> {remote}")
    remote_sh(f"mkdir -p '{staging}'")
    try:
        result = subprocess.run([scp, *key, *(str(p) for p in files), f"{host}:{staging}/"], check=False)
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")
        remote_sh(f"mv '{staging}'/*.pmtiles '{path}/' && rmdir '{staging}'")
    except BaseException:
        remote_sh(f"rm -rf '{staging}'", check=False)
        raise
    print("Upload done. Remote sizes:")
    remote_sh("stat -c '%s  %n' " + " ".join(f"'{path}/{p.name}'" for p in files))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build the bereikbaarheid_bzk PMTiles.")
    parser.add_argument(
        "--only", action="append", default=[], metavar="NAME",
        help="Build only these themes (e.g. APOTHEEK), 'gebieden' or 'studiegebied'; repeatable",
    )
    parser.add_argument("--jobs", type=int, default=8, help="Parallel grid conversions (default: 8)")
    parser.add_argument("--upload", action="store_true", help="Publish the archives when built")
    parser.add_argument("--remote", default=DEFAULT_REMOTE, metavar="USER@HOST:/PATH")
    parser.add_argument("--identity", default=str(DEFAULT_IDENTITY), metavar="KEYFILE")
    args = parser.parse_args(argv[1:])

    wanted = set(args.only)
    unknown = wanted - set(THEMES) - {"gebieden", "studiegebied"}
    if unknown:
        print(f"error: unknown --only {sorted(unknown)}", file=sys.stderr)
        return 2
    themes = [t for t in THEMES if not wanted or t in wanted]
    started = time.time()
    built: list[Path] = []

    if themes:
        print(f"Grids: {len(themes)} theme(s) x {len(REGIONS)} region(s), {args.jobs} jobs")
        jobs = [(t, r) for t in themes for r in REGIONS]
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            grids = list(pool.map(lambda job: grid_geojson(*job), jobs))
        by_theme = {t: [g for (jt, _), g in zip(jobs, grids) if jt == t] for t in themes}

        print("Vectors")
        with ThreadPoolExecutor(max_workers=max(1, args.jobs // 2)) as pool:
            vectors = dict(zip(themes, pool.map(vector_geojson, themes)))

        print("PMTiles")
        for theme in themes:
            spec = theme_spec(theme, by_theme[theme], vectors[theme])
            built.append(build_pmtiles(f"ber_{theme}", spec, GRID_BAND[0], VECTOR_BAND[1], True))

    if not wanted or "gebieden" in wanted:
        print("Gebiedsindelingen")
        spec = {level: [{"file": str(gebied_geojson(level))}] for level in GEBIEDEN}
        built.append(build_pmtiles("ber_gebieden_2022", spec, GRID_BAND[0], VECTOR_BAND[1], False))

    if not wanted or "studiegebied" in wanted:
        print("Studiegebied")
        spec = {"studyarea": [{"file": str(studyarea_geojson())}]}
        built.append(build_pmtiles("ber_studiegebied", spec, 0, VECTOR_BAND[1], False))

    total = sum(p.stat().st_size for p in built)
    print(f"\nDone in {time.time() - started:.0f}s — {len(built)} archive(s), {total:,} bytes in {PMTILES_OUT}")

    if args.upload:
        upload(built, args.remote, Path(args.identity))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
