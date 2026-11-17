#!/usr/bin/env python3
"""Build the CBS wijk/buurt archives and the wijk-informatie sidecar for
objectvision's ``wonenenzorgopdekaart`` variant.

Three outputs, the first two a matched pair (see ``data/locatieinfo/README.md``):

| File | Holds |
|---|---|
| ``pmtiles/wonenenzorgopdekaart/wijk.pmtiles`` | layer ``wijk``: ``code``, ``naam``, ``gm_code``, ``gemeente``, ``row`` |
| ``parquet/wonenenzorgopdekaart/wijk_informatie_2026.parquet`` | one row per wijk, same order: WoonZorgwijzer 5 tables + voorzieningen |
| ``pmtiles/wonenenzorgopdekaart/buurt.pmtiles`` | layer ``buurt``: ``code``, ``naam``, ``gm_code``, ``gemeente`` |

**Geometry** comes from ``cbsgebiedsindelingen2025.gpkg``, in two zoom bands per
layer: ``*_gegeneraliseerd`` up to z11 and ``*_niet_gegeneraliseerd`` from z12
(``convert-geojson-to-pmtiles.py``'s ``NAME=PATH@MIN-MAX`` bands, one target
layer). Both bands of ``wijk`` carry the same ``row``.

**``row``** is the wijk's index in ``wijk_gegeneraliseerd`` sorted by
``statcode``. It depends on the gpkg alone, so the archives can be rebuilt
without the sidecar's inputs — but a new gpkg means rebuilding and uploading
both, with the same ``?v=`` stamp. ``keyField: "code"`` in the layer config
turns a mismatched pair into an error rather than another wijk's data.

**The sidecar** joins, by wijk code:

* the WoonZorgwijzer 5 wijk tables, read from the tippecanoe tiles on the WZW5
  MapGallery fileserver (``wzw5-data``, an ~/.ssh/config alias). Tippecanoe
  stops dropping features at z11, so z12 holds every wijk with all its
  attributes; that one zoom level is fetched once (``--refetch`` to renew) and
  decoded here. The values are WZW's own display strings (``"2,1"``, ``",3"``,
  ``" "`` for none) and are kept as text, normalised (``"0,3"``, null), so the
  window shows what WZW shows. Only the fields the template uses are kept.
  WZW is on the **2024** wijkindeling: wijken whose code changed in 2025 get
  no WZW values (shown as ``–``), and the count is printed.
* the nearest voorzieningen per wijk, from GeoDMS
  ``.../locatieinfo_wijk_nl_geojson/export`` (``WoonZorgwijzer_clientside_rendering``,
  ``cfg/stam/brondata.dms``). A file without the ``*_afstand`` fields is an
  older export and stops the build; ``--no-info`` builds the archives alone.

The template is ``locatieinfo/template/wijk-informatie-wzw.html``.

Interpreters: this script and the parquet step need geopandas; the PMTiles
step needs the GDAL bindings, which on Windows come from OSGeo4W — found the
same way ``build-years-pmtiles.py`` finds them.

Usage:
    python data/build-wijk-buurt.py                 # everything, then print the ?v= stamp
    python data/build-wijk-buurt.py --no-info       # wijk/buurt archives only
    python data/build-wijk-buurt.py --upload        # ...and publish to ov-data
    python data/build-wijk-buurt.py --refetch       # fetch the WZW5 tiles again
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd

HERE = Path(__file__).resolve().parent

GPKG = Path("D:/SourceData/CBS/2025/cbsgebiedsindelingen2025.gpkg")
VOORZIENINGEN = Path(
    "C:/LocalData/woonzorgwijzer_clientside_rendering/cbs100m_grid_data/2026/"
    "parquet_nl/wijk_locatieinfo_nl_2026.geojson"
)
TEMPLATE = HERE / "locatieinfo" / "template" / "wijk-informatie-wzw.html"

WZW_HOST = "wzw5-data"
WZW_TILES = "/data/woonzorgwijzer5/v1/public/layers/wijken"
WZW_ZOOM = "12"
WZW_LAYER = "wijken"
WZW_CODE = "wijkcode"
WZW_CACHE = HERE / "wzw5_mapgallery" / f"wijken_z{WZW_ZOOM}"

WORK = HERE / "geojson" / "wijk_buurt"
PMTILES_DIR = HERE / "pmtiles" / "wonenenzorgopdekaart"
PARQUET_DIR = HERE / "parquet" / "wonenenzorgopdekaart"
SIDECAR = PARQUET_DIR / "wijk_informatie_2026.parquet"

REMOTE_ROOT = "ov-data:/var/www/objectvision_data"
REMOTE_DIRS = {
    "pmtiles": f"{REMOTE_ROOT}/pmtiles/wonenenzorgopdekaart",
    "parquet": f"{REMOTE_ROOT}/parquet/wonenenzorgopdekaart",
    "template": f"{REMOTE_ROOT}/meta/wonenenzorgopdekaart/locatieinfo",
}

CONVERT_PMTILES = HERE / "convert-geojson-to-pmtiles.py"
CONVERT_PARQUET = HERE / "convert-geojson-to-parquet.py"
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

# Generalized geometry up to GEN_MAXZOOM, full detail from there to MAXZOOM
# (MapLibre overzooms past the archive's maxzoom).
GEN_MAXZOOM, MAXZOOM = 11, 14

VOORZIENING_TYPES = (
    "apotheek", "dagbesteding", "fysiotherapeut", "huisarts", "ontmoeting",
    "ov", "supermarkt", "tandarts", "ziekenhuis",
)
VOORZIENING_FIELDS = [f"{t}_{s}" for t in VOORZIENING_TYPES for s in ("naam", "adres", "afstand")]

# Sidecar fields this script fills itself; the rest of the template's
# placeholders must come from the WZW5 tiles or the voorzieningen.
OWN_FIELDS = {"row", "code", "naam", "gemeente"}

# Sidecar row groups: a click downloads one. The table is ~3.4k rows by ~370
# mostly-short string columns, so small groups keep a click's download small.
SIDECAR_BATCH = 128


# --- helpers ---------------------------------------------------------------

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


def has_module(interpreter: list[str], module: str) -> bool:
    result = subprocess.run(
        interpreter + ["-c", f"import {module}"], check=False, capture_output=True, text=True
    )
    return result.returncode == 0


def pmtiles_interpreter() -> list[str]:
    """An interpreter with the GDAL bindings (see build-years-pmtiles.py)."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for name in ("python-qgis.bat", "python3.exe", "python.exe"):
        found = shutil.which(name)
        if found and [found] not in candidates:
            candidates.append([found])
    for candidate in candidates:
        if has_module(candidate, "osgeo"):
            print(f"PMTiles with: {Path(candidate[0]).name}")
            return candidate
    raise SystemExit(
        "error: no interpreter with the GDAL bindings (osgeo) for the PMTiles step.\n"
        f"  Windows/OSGeo4W: expected {OSGEO4W_PYTHON}\n"
        "  conda:           conda install -c conda-forge gdal"
    )


def resolve_ssh_tool(name: str) -> str:
    # Windows OpenSSH reaches the ssh agent; Git Bash's ssh does not.
    if sys.platform == "win32":
        bundled = WINDOWS_OPENSSH / f"{name}.exe"
        if bundled.is_file():
            return str(bundled)
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"error: {name} not found on PATH")
    return found


# --- WoonZorgwijzer 5 tiles ------------------------------------------------

def fetch_wzw_tiles(refetch: bool) -> None:
    """Copy one zoom level of the WZW5 wijken tiles into WZW_CACHE."""
    if WZW_CACHE.is_dir() and any(WZW_CACHE.rglob("*.pbf*")) and not refetch:
        print(f"WZW5 tiles: cached in {WZW_CACHE.relative_to(HERE)}")
        return
    if WZW_CACHE.exists():
        shutil.rmtree(WZW_CACHE)
    WZW_CACHE.mkdir(parents=True)
    print(f"WZW5 tiles: fetching z{WZW_ZOOM} from {WZW_HOST}")
    ssh = resolve_ssh_tool("ssh")
    with subprocess.Popen(
        [ssh, "-o", "BatchMode=yes", WZW_HOST, f"tar cf - -C '{WZW_TILES}/{WZW_ZOOM}' ."],
        stdout=subprocess.PIPE,
    ) as proc:
        assert proc.stdout is not None
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
            tar.extractall(WZW_CACHE, filter="data")
    if proc.returncode != 0:
        shutil.rmtree(WZW_CACHE, ignore_errors=True)
        raise SystemExit(f"error: fetching the WZW5 tiles failed (exit {proc.returncode})")


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def _fields(buf: bytes):
    """(field number, value) for each field of one protobuf message."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            size, i = _varint(buf, i)
            value, i = buf[i:i + size], i + size
        elif wire == 1:
            value, i = buf[i:i + 8], i + 8
        elif wire == 5:
            value, i = buf[i:i + 4], i + 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        yield number, value


def _mvt_value(buf: bytes):
    for number, value in _fields(buf):
        if number == 1:
            return value.decode("utf-8")
        if number == 2:
            return struct.unpack("<f", value)[0]
        if number == 3:
            return struct.unpack("<d", value)[0]
        if number in (4, 5):
            return value
        if number == 6:
            return (value >> 1) ^ -(value & 1)
        if number == 7:
            return bool(value)
    return None


def mvt_attributes(tile: bytes, layer: str):
    """The attributes of every feature of ``layer`` in one vector tile.

    Attribute-only MVT decoding (vector_tile.proto: Tile.layers=3;
    Layer.name=1, features=2, keys=3, values=4; Feature.tags=2) — the geometry
    is not needed, so no decoder dependency is either.
    """
    for number, raw in _fields(tile):
        if number != 3:
            continue
        name, keys, values, features = None, [], [], []
        for field, value in _fields(raw):
            if field == 1:
                name = value.decode("utf-8")
            elif field == 2:
                features.append(value)
            elif field == 3:
                keys.append(value.decode("utf-8"))
            elif field == 4:
                values.append(_mvt_value(value))
        if name != layer:
            continue
        for feature in features:
            tags: list[int] = []
            for field, value in _fields(feature):
                if field == 2:
                    j = 0
                    while j < len(value):
                        tag, j = _varint(value, j)
                        tags.append(tag)
            yield {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags), 2)}


def normalise_wzw(value):
    """WZW's display strings: blank -> None, ",3" -> "0,3"; others unchanged."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return re.sub(r"^(-?),", r"\g<1>0,", text)


def read_wzw(wanted: set[str]) -> pd.DataFrame:
    """One row per WZW wijk with the ``wanted`` fields (lowercased)."""
    by_code: dict[str, dict] = {}
    tiles = sorted(WZW_CACHE.rglob("*.pbf*"))
    for path in tiles:
        raw = path.read_bytes()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        for props in mvt_attributes(raw, WZW_LAYER):
            code = props.get(WZW_CODE)
            if not code:
                continue
            seen = by_code.setdefault(code, props)
            if seen is not props and seen != props:
                raise SystemExit(f"error: WZW5 wijk {code} differs between tiles")
    if not by_code:
        raise SystemExit(f"error: no '{WZW_LAYER}' features in {WZW_CACHE}")

    rows = []
    for code, props in by_code.items():
        lowered = {k.lower(): v for k, v in props.items()}
        if len(lowered) != len(props):
            raise SystemExit("error: WZW5 field names collide when lowercased")
        row = {name: normalise_wzw(lowered.get(name)) for name in wanted}
        row[WZW_CODE] = code
        rows.append(row)
    missing = sorted(wanted - {k.lower() for k in next(iter(by_code.values()))})
    if missing:
        raise SystemExit(f"error: template fields not in the WZW5 tiles: {missing[:20]}")
    print(f"WZW5: {len(by_code):,} wijken from {len(tiles):,} tiles")
    return pd.DataFrame(rows)


# --- CBS geometry ----------------------------------------------------------

def read_level(level: str, generalised: bool) -> gpd.GeoDataFrame:
    layer = f"{level}_{'gegeneraliseerd' if generalised else 'niet_gegeneraliseerd'}"
    gdf = gpd.read_file(GPKG, layer=layer)
    gdf = gdf.rename(columns={"statcode": "code", "statnaam": "naam"})
    return gdf[["code", "naam", "gm_code", "geometry"]]


def gemeente_names() -> dict[str, str]:
    gm = gpd.read_file(GPKG, layer="gemeente_gegeneraliseerd", ignore_geometry=True)
    return dict(zip(gm["statcode"], gm["statnaam"]))


def wijk_rows() -> pd.Series:
    """wijk code -> row: the sidecar order, shared by both wijk bands."""
    codes = sorted(gpd.read_file(GPKG, layer="wijk_gegeneraliseerd", ignore_geometry=True)["statcode"])
    if len(set(codes)) != len(codes):
        raise SystemExit("error: duplicate wijk codes in the gpkg")
    return pd.Series(range(len(codes)), index=codes, dtype="int64")


def write_band(level: str, generalised: bool, rows: pd.Series | None, gemeenten: dict[str, str]) -> Path:
    out = WORK / f"{level}_{'gen' if generalised else 'detail'}.geojson"
    if is_fresh(out, [GPKG, Path(__file__)]):
        return out
    gdf = read_level(level, generalised)
    gdf["gemeente"] = gdf["gm_code"].map(gemeenten)
    if rows is not None:
        gdf["row"] = gdf["code"].map(rows)
        if gdf["row"].isna().any():
            raise SystemExit(f"error: {level} codes without a row: {gdf.loc[gdf['row'].isna(), 'code'].tolist()[:5]}")
        gdf["row"] = gdf["row"].astype("int64")
    gdf = gdf.to_crs(epsg=4326)
    WORK.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    print(f"  wrote {out.relative_to(HERE)} ({len(gdf):,} features)")
    return out


def build_archive(level: str, gen: Path, detail: Path, interpreter: list[str]) -> Path:
    out = PMTILES_DIR / f"{level}.pmtiles"
    if is_fresh(out, [gen, detail]):
        print(f"{level}.pmtiles: up to date")
        return out
    PMTILES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{level}.pmtiles: tiling z0-{GEN_MAXZOOM} generalised, z{GEN_MAXZOOM + 1}-{MAXZOOM} detail")
    run(
        [
            *interpreter, str(CONVERT_PMTILES),
            "--layer", f"{level}={gen}@0-{GEN_MAXZOOM}",
            "--layer", f"{level}={detail}@{GEN_MAXZOOM + 1}-{MAXZOOM}",
            "--minzoom", "0", "--maxzoom", str(MAXZOOM),
            "-o", str(out),
        ],
        f"tiling {level}",
    )
    print(f"  wrote {out.relative_to(HERE)} ({out.stat().st_size:,} bytes)")
    return out


# --- sidecar ---------------------------------------------------------------

def template_fields() -> set[str]:
    html = TEMPLATE.read_text(encoding="utf-8")
    fields = set(re.findall(r"\[\[\s*([\w.]+)", html))
    fields |= set(re.findall(r'data-(?:distance|slice)="([\w.]+)"', html))
    return fields


def repair_utf8(raw: bytes) -> tuple[bytes, int]:
    """Re-encode the byte runs that are not valid UTF-8 as cp1252 -> UTF-8.

    The voorzieningen sources are partly Latin-1/cp1252, partly UTF-8, and
    GeoDMS's own detection misses names mixing both ("Raphaël… – …"), so the
    export can carry a few stray cp1252 bytes. Valid UTF-8 is left as it is.
    """
    fixed = 0

    def fix(match: re.Match[bytes]) -> bytes:
        nonlocal fixed
        run = match.group()
        try:
            run.decode("utf-8")
            return run
        except UnicodeDecodeError:
            fixed += 1
            return run.decode("cp1252", errors="replace").encode("utf-8")

    return re.sub(rb"[\x80-\xff]+", fix, raw), fixed


def read_voorzieningen() -> pd.DataFrame:
    raw, fixed = repair_utf8(VOORZIENINGEN.read_bytes())
    if fixed:
        print(f"Voorzieningen: re-encoded {fixed} cp1252 run(s) in {VOORZIENINGEN.name}")
    gdf = gpd.read_file(io.BytesIO(raw), ignore_geometry=True)
    missing = [f for f in VOORZIENING_FIELDS if f not in gdf.columns]
    if missing:
        raise SystemExit(
            f"error: {VOORZIENINGEN.name} lacks the voorzieningen fields ({len(missing)} missing, "
            f"e.g. {missing[:3]}).\n"
            "  It is an older export: rerun GeoDMS .../locatieinfo_wijk_nl_geojson/export,\n"
            "  or pass --no-info to build the wijk/buurt archives alone."
        )
    voorz = gdf[["WK_CODE", *VOORZIENING_FIELDS]].rename(columns={"WK_CODE": "code"})
    if voorz["code"].duplicated().any():
        raise SystemExit(f"error: duplicate WK_CODE in {VOORZIENINGEN.name}")
    return voorz


def build_sidecar(rows: pd.Series, gemeenten: dict[str, str], wzw_wanted: set[str]) -> Path:
    inputs = [GPKG, VOORZIENINGEN, TEMPLATE, Path(__file__), *WZW_CACHE.rglob("*.pbf*")]
    if is_fresh(SIDECAR, inputs):
        print(f"{SIDECAR.name}: up to date")
        return SIDECAR

    wijken = gpd.read_file(GPKG, layer="wijk_gegeneraliseerd", ignore_geometry=True)
    table = pd.DataFrame({
        "row": rows.values,
        "code": rows.index,
    })
    names = dict(zip(wijken["statcode"], wijken["statnaam"]))
    gm = dict(zip(wijken["statcode"], wijken["gm_code"]))
    table["naam"] = table["code"].map(names)
    table["gemeente"] = table["code"].map(gm).map(gemeenten)

    wzw = read_wzw(wzw_wanted)
    voorz = read_voorzieningen()
    table = table.merge(wzw, how="left", left_on="code", right_on=WZW_CODE, suffixes=("", "_wzw"))
    table = table.merge(voorz, how="left", on="code")
    if len(table) != len(rows) or not (table["row"].to_numpy() == rows.to_numpy()).all():
        raise SystemExit("error: the joins changed the row order")

    n = len(table)
    no_wzw = int(table[WZW_CODE].isna().sum())
    no_voorz = int(table["huisarts_afstand"].isna().sum())
    print(f"Sidecar: {n:,} wijken; {n - no_wzw:,} with WZW5 data ({no_wzw:,} without: "
          "code changed after 2024, or a wijk WZW does not cover); "
          f"{n - no_voorz:,} with voorzieningen")

    missing = sorted(template_fields() - set(table.columns))
    if missing:
        raise SystemExit(f"error: template placeholders with no sidecar column: {missing}")

    # Geometry-less GeoJSON: convert-geojson-to-parquet.py writes it as a plain
    # table (its attribute-table branch), with the usual lowercasing/narrowing.
    WORK.mkdir(parents=True, exist_ok=True)
    staged = WORK / "wijk_informatie_2026.geojson"
    records = json.loads(table.to_json(orient="records"))
    collection = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": r, "geometry": None} for r in records],
    }
    staged.write_text(json.dumps(collection, ensure_ascii=False), encoding="utf-8")

    SIDECAR.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            sys.executable, str(CONVERT_PARQUET), str(staged), str(SIDECAR),
            "--batch-size", str(SIDECAR_BATCH), "--no-statistics", "--no-bool",
        ],
        "writing the sidecar parquet",
    )
    print(f"  wrote {SIDECAR} ({SIDECAR.stat().st_size:,} bytes, {len(table.columns)} columns)")
    return SIDECAR


# --- upload ----------------------------------------------------------------

def upload(files: list[Path], remote: str) -> None:
    """Copy files to ``remote`` via a staging folder; the replaced ones become ``.bak``."""
    ssh, scp = resolve_ssh_tool("ssh"), resolve_ssh_tool("scp")
    host, _, path = remote.partition(":")
    path = path.rstrip("/")
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    def remote_sh(script: str, check: bool = True) -> None:
        result = subprocess.run([ssh, "-o", "BatchMode=yes", host, script], check=False, text=True)
        if check and result.returncode != 0:
            raise SystemExit(f"error: remote command failed (exit {result.returncode})")

    print(f"Uploading {', '.join(p.name for p in files)} -> {remote}")
    remote_sh(f"mkdir -p '{staging}'")
    try:
        result = subprocess.run([scp, "-o", "BatchMode=yes", *(str(p) for p in files), f"{host}:{staging}/"], check=False)
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")
        moves = " && ".join(
            f"{{ [ ! -f '{path}/{p.name}' ] || mv -f '{path}/{p.name}' '{path}/{p.name}.bak'; }} && "
            f"mv '{staging}/{p.name}' '{path}/{p.name}'"
            for p in files
        )
        remote_sh(f"{moves} && rmdir '{staging}'")
    except BaseException:
        remote_sh(f"rm -rf '{staging}'", check=False)
        raise
    remote_sh("stat -c '%s  %n' " + " ".join(f"'{path}/{p.name}'" for p in files))


# --- main ------------------------------------------------------------------

def main(argv: list[str]) -> int:
    global VOORZIENINGEN, SIDECAR
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--no-info", action="store_true", help="build the wijk/buurt archives only, no sidecar")
    parser.add_argument("--refetch", action="store_true", help="fetch the WZW5 tiles again")
    parser.add_argument("--upload", action="store_true", help="publish to the objectvision data host")
    parser.add_argument("--voorzieningen", type=Path, default=VOORZIENINGEN, metavar="GEOJSON",
                        help=f"the GeoDMS voorzieningen export (default: {VOORZIENINGEN})")
    parser.add_argument("--sidecar", type=Path, default=SIDECAR, metavar="PARQUET",
                        help="where to write the sidecar (default: parquet/wonenenzorgopdekaart/)")
    args = parser.parse_args(argv[1:])
    VOORZIENINGEN, SIDECAR = args.voorzieningen, args.sidecar.resolve()

    if not GPKG.is_file():
        raise SystemExit(f"error: {GPKG} not found")

    gemeenten = gemeente_names()
    rows = wijk_rows()
    print(f"CBS 2025: {len(rows):,} wijken")

    sidecar = None
    if not args.no_info:
        if not VOORZIENINGEN.is_file():
            raise SystemExit(f"error: {VOORZIENINGEN} not found (or pass --no-info)")
        read_voorzieningen()  # fail before the slow steps when the export is stale
        fetch_wzw_tiles(args.refetch)
        wanted = template_fields() - OWN_FIELDS - set(VOORZIENING_FIELDS)
        sidecar = build_sidecar(rows, gemeenten, wanted)

    interpreter = pmtiles_interpreter()
    archives = []
    for level in ("wijk", "buurt"):
        level_rows = rows if level == "wijk" else None
        gen = write_band(level, True, level_rows, gemeenten)
        detail = write_band(level, False, level_rows, gemeenten)
        archives.append(build_archive(level, gen, detail, interpreter))

    if args.upload:
        upload(archives, REMOTE_DIRS["pmtiles"])
        if sidecar is not None:
            upload([sidecar], REMOTE_DIRS["parquet"])
            upload([TEMPLATE], REMOTE_DIRS["template"])

    print(f"\nVersion stamp for layers.json: ?v={time.strftime('%Y%m%d')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
