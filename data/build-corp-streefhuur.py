#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Build the corporatie and streefhuur layers of WoonZorgLimburg (dataontwikkel).

Two PMTiles archives and their ``filterRaster`` companions in ``cog/comparison``:

    corporaties_lb_2026.pmtiles   one layer ``corporaties_lb_2026``, z6-14
        source  geojson/corp_lb_2026.geojson  (GeoDMS export of
                corporaties_lb/impl/alle, EPSG:28992, one polygon per VBO)
        COGs    corp_<naam>_2026.cog.tif, one per styled attribute

    streefhuur_lb_2026.pmtiles    layers ``streefhuur_0`` .. ``streefhuur_5``, z0-14
        source  tif/streefhuur_<i>.tif  (5 m class rasters, classes 1-5, 255 = nodata)
        COGs    streefhuur_<i>.cog.tif

Corporaties
-----------
The GeoDMS export carries more than the map uses (pand_id, vbo_id, statuses,
match method) and upper-case field names. Only the fields of the published
archive are kept, lower-cased, so ``layers.json`` needs no change:

    bat_score gm_code wk_code bu_code corporatie zorgaanbieder senioren
    ouderen_met_indicatie aandachtsgroepen mutatiegraad inpandige_gemsch_ruimte

Features without geometry (lijstwerk rows that matched no BAG object) are
dropped. The export is UTF-8 apart from the odd byte that came through from a
cp850 spreadsheet ("Agap\\x82 zorg"); such bytes are decoded as cp850.

``convert-geojson-to-cog-10m.py`` skips boolean values, so the COG step reads a
second copy with booleans as 0/1. The app compares with ``==`` (loose), so a
cell holding 0 still matches ``["==", "senioren", false]``.

COG grid
--------
Every COG is warped/burned onto the grid of the existing ``cog/comparison`` set
(EPSG:3857, 7168x19712, overviews 2-16) with ``--like``. The reference is
fetched from the server into the work folder on first use.

Uploading goes over ssh to the ``wzl-data`` alias from ``~/.ssh/config``. The
file it replaces is kept next to it as ``<name>.prev``.

Usage:
    python build-corp-streefhuur.py                       # build everything
    python build-corp-streefhuur.py --only corp --upload
    python build-corp-streefhuur.py --no-build --upload   # upload the last build
    python build-corp-streefhuur.py --skip-cog
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
GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"
TIF_TO_GEOJSON = HERE / "convert-tif-to-geojson.py"
GEOJSON_TO_COG = HERE / "convert-geojson-to-cog-10m.py"
TIF_TO_COG = HERE / "convert-tif-to-cog-10m.py"
LAYERS_JSON = HERE.parent / "configs" / "woonzorglimburg_ontwikkel" / "layers.json"

OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

WORK_DIR = HERE / "corp_streefhuur"
CORP_SOURCE = HERE / "geojson" / "corp_lb_2026.geojson"
STREEFHUUR_SOURCES = [HERE / "tif" / f"streefhuur_{i}.tif" for i in range(6)]

CORP_ARCHIVE = WORK_DIR / "corporaties_lb_2026.pmtiles"
STREEFHUUR_ARCHIVE = WORK_DIR / "streefhuur_lb_2026.pmtiles"
CORP_LAYER = "corporaties_lb_2026"

# source field -> field in the archive (the published field set)
CORP_FIELDS = {
    "BAT_score": "bat_score",
    "GM_CODE": "gm_code",
    "WK_CODE": "wk_code",
    "BU_CODE": "bu_code",
    "corporatie": "corporatie",
    "zorgaanbieder": "zorgaanbieder",
    "senioren": "senioren",
    "ouderen_met_indicatie": "ouderen_met_indicatie",
    "aandachtsgroepen": "aandachtsgroepen",
    "mutatiegraad": "mutatiegraad",
    "inpandige_gemsch_ruimte": "inpandige_gemsch_ruimte",
}
# COG name (corp_<name>_2026) -> property burned
CORP_COGS = {
    "bat": "bat_score",
    "mutatiegraad": "mutatiegraad",
    "senioren": "senioren",
    "ouderen_met_indicatie": "ouderen_met_indicatie",
    "aandachtsgroepen": "aandachtsgroepen",
    "inpandige_gemsch_ruimte": "inpandige_gemsch_ruimte",
    "corporatie": "corporatie",
}
RULE_CHECKED_COGS = {"bat", "corporatie"}

CORP_ZOOM = (6, 14)
STREEFHUUR_ZOOM = (0, 14)
MAX_SIZE = 4_000_000
MAX_FEATURES = 1_000_000

HOST = "wzl-data"
PMTILES_REMOTE = "/var/www/woonzorglimburg_dataontwikkel/pmtiles"
COG_REMOTE = "/var/www/woonzorglimburg_dataontwikkel/cog/comparison"
COG_REFERENCE = "streefhuur_0.cog.tif"  # any file of the comparison set; all share one grid


def log(message: str) -> None:
    print(message, flush=True)


def run(command: list[str], what: str) -> None:
    log(f"\n> {what}")
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: {what} failed (exit {result.returncode})")


def gdal_interpreter() -> list[str]:
    """An interpreter that can import the GDAL bindings (``osgeo``) and rasterio."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for candidate in candidates:
        result = subprocess.run(candidate + ["-c", "import osgeo, rasterio"],
                                check=False, capture_output=True, text=True)
        if result.returncode == 0:
            return candidate
    raise SystemExit("error: no interpreter found with the GDAL bindings (osgeo) and rasterio")


def ssh_tool(name: str) -> str:
    if sys.platform == "win32":
        bundled = WINDOWS_OPENSSH / f"{name}.exe"
        if bundled.is_file():
            return str(bundled)
    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"error: {name} not found on PATH")
    return found


# --- corporaties -----------------------------------------------------------

def decode_mixed(raw: bytes) -> str:
    """UTF-8, with any byte that is not valid UTF-8 read as cp850."""
    def fallback(err: UnicodeDecodeError) -> tuple[str, int]:
        return err.object[err.start:err.end].decode("cp850"), err.end

    import codecs
    codecs.register_error("cp850_fallback", fallback)
    text = raw.decode("utf-8", errors="cp850_fallback")
    return text.lstrip("\ufeff")


def stage_corporaties() -> tuple[Path, Path]:
    log(f"Staging {CORP_SOURCE.name}")
    data = json.loads(decode_mixed(CORP_SOURCE.read_bytes()))
    features = data.get("features", [])
    kept = []
    for feature in features:
        if not feature.get("geometry"):
            continue
        props = feature.get("properties") or {}
        feature["properties"] = {dst: props.get(src) for src, dst in CORP_FIELDS.items()}
        kept.append(feature)
    log(f"  {len(features):,} features, {len(features) - len(kept):,} without geometry dropped")

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    out = {"type": "FeatureCollection", "name": CORP_LAYER, "crs": data.get("crs"), "features": kept}
    pm_path = WORK_DIR / "corp_pmtiles.geojson"
    pm_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    for feature in kept:
        props = feature["properties"]
        for key, value in props.items():
            if isinstance(value, bool):
                props[key] = int(value)
    cog_path = WORK_DIR / "corp_cog.geojson"
    cog_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return pm_path, cog_path


def build_corporaties(py: list[str], with_cog: bool, reference: Path | None) -> list[Path]:
    pm_path, cog_path = stage_corporaties()
    run(py + [str(GEOJSON_TO_PMTILES), "-o", str(CORP_ARCHIVE),
              "--layer", f"{CORP_LAYER}={pm_path}",
              "--minzoom", str(CORP_ZOOM[0]), "--maxzoom", str(CORP_ZOOM[1]),
              "--max-size", str(MAX_SIZE), "--max-features", str(MAX_FEATURES),
              "--name", CORP_ARCHIVE.stem,
              "--description", "Corporatiebezit Limburg 2026 (lijstwerken, gekoppeld aan BAG)"],
        f"build {CORP_ARCHIVE.name}")
    built = [CORP_ARCHIVE]
    if with_cog:
        # the burner wants the reference grid's CRS (EPSG:3857)
        cog_3857 = WORK_DIR / "corp_cog_3857.geojson"
        run(py + ["-c", "import sys; from osgeo import gdal; gdal.UseExceptions(); "
                        "gdal.VectorTranslate(sys.argv[2], sys.argv[1], format='GeoJSON', dstSRS='EPSG:3857')",
                  str(cog_path), str(cog_3857)], f"reproject {cog_path.name} -> EPSG:3857")
        cog_path = cog_3857
        for name, prop in CORP_COGS.items():
            layer_id = f"corp_{name}_2026"
            out = WORK_DIR / f"{layer_id}.cog.tif"
            # the rule check understands numeric "==" only; range (mutatiegraad) and
            # boolean rules would always be reported as uncovered
            check = (["--match-rules", str(LAYERS_JSON), "--layer-id", layer_id]
                     if name in RULE_CHECKED_COGS else [])
            run(py + [str(GEOJSON_TO_COG), str(cog_path), str(out), "--property", prop,
                      "--like", str(reference)] + check,
                f"burn {out.name}")
            built.append(out)
    return built


# --- streefhuur ------------------------------------------------------------

def build_streefhuur(py: list[str], with_cog: bool, reference: Path | None) -> list[Path]:
    missing = [p for p in STREEFHUUR_SOURCES if not p.is_file()]
    if missing:
        raise SystemExit("error: input not found:\n  " + "\n  ".join(map(str, missing)))
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    command = py + [str(GEOJSON_TO_PMTILES), "-o", str(STREEFHUUR_ARCHIVE),
                    "--minzoom", str(STREEFHUUR_ZOOM[0]), "--maxzoom", str(STREEFHUUR_ZOOM[1]),
                    "--max-size", str(MAX_SIZE), "--max-features", str(MAX_FEATURES),
                    "--name", STREEFHUUR_ARCHIVE.stem,
                    "--description", "Streefhuur t.o.v. huurgrenzen, Limburg 2026"]
    for tif in STREEFHUUR_SOURCES:
        geojson = WORK_DIR / f"{tif.stem}.geojson"
        run(py + [str(TIF_TO_GEOJSON), str(tif), str(geojson), "--nodata", "255"], f"vectorise {tif.name}")
        command += ["--layer", f"{tif.stem}={geojson}"]
    run(command, f"build {STREEFHUUR_ARCHIVE.name}")
    built = [STREEFHUUR_ARCHIVE]
    if with_cog:
        for tif in STREEFHUUR_SOURCES:
            out = WORK_DIR / f"{tif.stem}.cog.tif"
            run(py + [str(TIF_TO_COG), str(tif), str(out), "--nodata", "255",
                      "--like", str(reference), "--expect-grid", str(reference)],
                f"warp {out.name}")
            built.append(out)
    return built


def fetch_reference() -> Path:
    reference = WORK_DIR / "reference" / COG_REFERENCE
    if not reference.is_file():
        reference.parent.mkdir(parents=True, exist_ok=True)
        run([ssh_tool("scp"), f"{HOST}:{COG_REMOTE}/{COG_REFERENCE}", str(reference)],
            f"fetch grid reference {COG_REFERENCE}")
    return reference


# --- upload ----------------------------------------------------------------

def upload(files: list[Path]) -> None:
    """Stage on the host, keep the replaced file as .prev, then mv into place (atomic)."""
    ssh, scp = ssh_tool("ssh"), ssh_tool("scp")
    by_dir: dict[str, list[Path]] = {}
    for f in files:
        by_dir.setdefault(PMTILES_REMOTE if f.suffix == ".pmtiles" else COG_REMOTE, []).append(f)

    def remote_sh(script: str, check: bool = True) -> None:
        result = subprocess.run([ssh, HOST, script], check=False, text=True)
        if check and result.returncode != 0:
            raise SystemExit(f"error: remote command failed on {HOST} (exit {result.returncode})")

    for path, group in by_dir.items():
        staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"
        log(f"\nUploading {len(group)} file(s) -> {HOST}:{path}")
        remote_sh(f"mkdir -p '{staging}'")
        try:
            result = subprocess.run([scp, *map(str, group), f"{HOST}:{staging}/"], check=False)
            if result.returncode != 0:
                raise SystemExit(f"error: scp to {HOST} failed (exit {result.returncode})")
            moves = " && ".join(
                f"chmod a+r '{staging}/{f.name}' && "
                f"{{ [ ! -f '{path}/{f.name}' ] || cp -p '{path}/{f.name}' '{path}/{f.name}.prev'; }} && "
                f"mv '{staging}/{f.name}' '{path}/'"
                for f in group)
            remote_sh(f"{moves} && rmdir '{staging}'")
        except BaseException:
            remote_sh(f"rm -rf '{staging}'", check=False)
            raise
        remote_sh("stat -c '%s  %y  %n' " + " ".join(f"'{path}/{f.name}'" for f in group))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", choices=("corp", "streefhuur"), help="Build/upload just one of the two")
    parser.add_argument("--skip-cog", action="store_true", help="Do not build or upload the filterRaster COGs")
    parser.add_argument("--no-build", action="store_true", help="Skip building; upload the last build")
    parser.add_argument("--upload", action="store_true", help=f"Copy the results to {HOST}")
    args = parser.parse_args(argv[1:])

    parts = [args.only] if args.only else ["corp", "streefhuur"]
    with_cog = not args.skip_cog
    files: list[Path] = []
    if args.no_build:
        for part in parts:
            if part == "corp":
                files.append(CORP_ARCHIVE)
                if with_cog:
                    files += [WORK_DIR / f"corp_{n}_2026.cog.tif" for n in CORP_COGS]
            else:
                files.append(STREEFHUUR_ARCHIVE)
                if with_cog:
                    files += [WORK_DIR / f"{t.stem}.cog.tif" for t in STREEFHUUR_SOURCES]
        missing = [f for f in files if not f.is_file()]
        if missing:
            raise SystemExit("error: --no-build but not built yet:\n  " + "\n  ".join(map(str, missing)))
    else:
        py = gdal_interpreter()
        reference = fetch_reference() if with_cog else None
        started = time.monotonic()
        if "corp" in parts:
            files += build_corporaties(py, with_cog, reference)
        if "streefhuur" in parts:
            files += build_streefhuur(py, with_cog, reference)
        log(f"\nBuilt in {time.monotonic() - started:.0f} s:")
        for f in files:
            log(f"  {f.stat().st_size:>12,}  {f.name}")

    if args.upload:
        upload(files)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
