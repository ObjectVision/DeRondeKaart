#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Build the Leefbaarometer PMTiles: one layer per year, zoom-banded by cell size.

The source is the Leefbaarometer on the CBS 100 m grid, exported per year and
per aggregation level (native grid, EPSG:3857):

    <input-dir>/Y<year>_m1000.geojson   1000 m cells   -> z5-7
    <input-dir>/Y<year>_m500.geojson     500 m cells   -> z8
    <input-dir>/Y<year>_m200.geojson     200 m cells   -> z9-10
    <input-dir>/Y<year>_m5.geojson       100 m grid    -> z11-15

The zoom mapping is the one the WZW5 map gallery uses
(``convert_leefbaarometer_to_single_tiles.sh`` in WoonZorgwijzer_clientside_rendering),
so the map shows coarse averages when zoomed out and the grid itself when zoomed in.

Every year becomes ONE layer ``Y<year>`` in ONE archive, and the four files of
that year are its zoom bands. The three map layers built on it (leefbaarometerklasse,
dimensiescore overlast en onveiligheid, dimensiescore sociale samenhang) all read
the same archive: they differ only in the property their style looks at, and the
year slider switches between the ``Y<year>`` layers (``"sourceLayer": "Y%YEAR%"``).

Each feature carries seven scores; only the three the map uses are kept:

    lbm   leefbaarometer total score (classified into 9 classes by the style)
    onv   dimensiescore overlast en onveiligheid
    soc   dimensiescore sociale samenhang

They are rounded to 4 decimals on the way, which removes float32 noise
(``4.4299998``) and keeps the tile values small. The slim copies are written to
``leefbaarometer/staging/`` next to this script and reused with ``--skip-existing``.

The PMTiles step is ``convert-geojson-to-pmtiles.py``. It needs the GDAL bindings,
which on Windows come from OSGeo4W rather than pip; the current interpreter is
used when it has them, otherwise ``C:\\OSGeo4W\\bin\\python-qgis.bat``.

Uploading goes over ssh to host aliases from ``~/.ssh/config`` (see
``server/README.md``, "SSH host aliases"); by default to both data hosts.

Usage:
    python build-leefbaarometer-pmtiles.py
    python build-leefbaarometer-pmtiles.py --years 2023,2024 -o leefbaarometer/test.pmtiles
    python build-leefbaarometer-pmtiles.py --skip-existing --upload
    python build-leefbaarometer-pmtiles.py --no-build --upload      # upload the last build
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

# Only used as a fallback when the current interpreter has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")
# Windows ships OpenSSH here; preferred over the Git-for-Windows build, which
# cannot talk to the Windows ssh-agent.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

DEFAULT_INPUT_DIR = Path(
    r"C:\LocalData\woonzorgwijzer_clientside_rendering\cbs100m_grid_data\2026\leefbaarometer\native"
)
WORK_DIR = HERE / "leefbaarometer"
DEFAULT_OUTPUT = WORK_DIR / "leefbaarometer_2026.pmtiles"
STAGING_DIR = WORK_DIR / "staging"

# The years the gallery's slider covers. 2014 is on disk too, but not shown there.
DEFAULT_YEARS = tuple(str(year) for year in range(2015, 2025))

# (file suffix, minzoom, maxzoom), coarse to fine — the bands of each year's layer.
BANDS = (
    ("m1000", 5, 7),
    ("m500", 8, 8),
    ("m200", 9, 10),
    ("m5", 11, 15),
)
MINZOOM = BANDS[0][1]
MAXZOOM = BANDS[-1][2]

KEEP = ("lbm", "onv", "soc")
DECIMALS = 4

# The gallery built these with tippecanoe -pk -pf (no tile size or feature limit).
# Generous limits keep every cell at the coarse zooms, where one tile spans a
# whole province.
MAX_SIZE = 4_000_000
MAX_FEATURES = 1_000_000

DEFAULT_REMOTES = (
    "wzl-data:/var/www/woonzorglimburg_data/pmtiles",
    "ov-data:/var/www/objectvision_data/pmtiles",
)


def log(message: str) -> None:
    print(message, flush=True)


def parse_years(value: str) -> list[str]:
    years = [part.strip() for part in value.split(",") if part.strip()]
    if not years or not all(year.isdigit() and len(year) == 4 for year in years):
        raise argparse.ArgumentTypeError(f"--years expects e.g. 2015,2024, got {value!r}")
    return years


def pmtiles_interpreter() -> list[str]:
    """An interpreter that can import the GDAL bindings (``osgeo``)."""
    candidates = [[sys.executable]]
    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for candidate in candidates:
        result = subprocess.run(
            candidate + ["-c", "import osgeo"], check=False, capture_output=True, text=True
        )
        if result.returncode == 0:
            return candidate
    raise SystemExit(
        "error: no interpreter found with the GDAL bindings (osgeo).\n"
        f"  Windows/OSGeo4W:  expected {OSGEO4W_PYTHON}\n"
        "  conda:            conda install -c conda-forge gdal"
    )


def slim_value(value: object) -> object:
    return round(value, DECIMALS) if isinstance(value, float) else value


def stage(source: Path, target: Path) -> int:
    """Copy one GeoJSON keeping only the ``KEEP`` properties; return the feature count."""
    data = json.loads(source.read_text(encoding="utf-8-sig"))
    features = data.get("features", [])
    for feature in features:
        properties = feature.get("properties") or {}
        feature["properties"] = {key: slim_value(properties.get(key)) for key in KEEP}
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    # Keep "crs": the source is EPSG:3857, not the GeoJSON default WGS84.
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(target)
    return len(features)


def build(args: argparse.Namespace) -> Path:
    if not GEOJSON_TO_PMTILES.is_file():
        raise SystemExit(f"error: missing sibling script: {GEOJSON_TO_PMTILES}")

    missing = [
        args.input_dir / f"Y{year}_{suffix}.geojson"
        for year in args.years
        for suffix, _, _ in BANDS
        if not (args.input_dir / f"Y{year}_{suffix}.geojson").is_file()
    ]
    if missing:
        raise SystemExit("error: input not found:\n  " + "\n  ".join(map(str, missing)))

    output = args.output.resolve()
    command = pmtiles_interpreter() + [
        str(GEOJSON_TO_PMTILES),
        "-o", str(output),
        "--minzoom", str(MINZOOM),
        "--maxzoom", str(MAXZOOM),
        "--max-size", str(MAX_SIZE),
        "--max-features", str(MAX_FEATURES),
        "--name", output.stem,
        "--description", f"Leefbaarometer {args.years[0]}-{args.years[-1]} (lbm, onv, soc)",
    ]

    log(f"Staging {len(args.years)} year(s) x {len(BANDS)} band(s) into {STAGING_DIR}")
    for year in args.years:
        for suffix, lo, hi in BANDS:
            source = args.input_dir / f"Y{year}_{suffix}.geojson"
            staged = STAGING_DIR / source.name
            if args.skip_existing and staged.is_file():
                log(f"  Y{year} {suffix:<5} z{lo}-{hi}: reusing {staged.name}")
            else:
                count = stage(source, staged)
                log(f"  Y{year} {suffix:<5} z{lo}-{hi}: {count:,} feature(s)")
            command += ["--layer", f"Y{year}={staged}@{lo}-{hi}"]

    log(f"\nBuilding {output.name}…")
    started = time.monotonic()
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: building {output.name} failed (exit {result.returncode})")
    log(f"\nDone — {output} ({output.stat().st_size:,} bytes, {time.monotonic() - started:.0f} s)")
    return output


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


def upload(archive: Path, remote: str, identity: Path | None) -> None:
    """Copy the archive to a data host via a staging folder, then mv into place.

    scp writes straight into the destination file, so copying over a live archive
    would serve a half-written one; staging and moving makes it atomic.
    """
    ssh, scp = resolve_ssh_tool("ssh"), resolve_ssh_tool("scp")
    key = ["-i", str(identity)] if identity else []
    host, sep, path = remote.partition(":")
    if not sep or not path:
        raise SystemExit(f"error: --remote must look like host:/path, got {remote!r}")
    path = path.rstrip("/")
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    def remote_sh(script: str, check: bool = True) -> None:
        result = subprocess.run([ssh, *key, host, script], check=False, text=True)
        if check and result.returncode != 0:
            raise SystemExit(f"error: remote command failed on {host} (exit {result.returncode})")

    log(f"\nUploading {archive.name} ({archive.stat().st_size:,} bytes) -> {remote}")
    remote_sh(f"mkdir -p '{staging}'")
    try:
        result = subprocess.run([scp, *key, str(archive), f"{host}:{staging}/"], check=False)
        if result.returncode != 0:
            raise SystemExit(f"error: scp to {host} failed (exit {result.returncode})")
        remote_sh(
            f"chmod a+r '{staging}/{archive.name}' && mkdir -p '{path}' "
            f"&& mv '{staging}/{archive.name}' '{path}/' && rmdir '{staging}'"
        )
    except BaseException:
        remote_sh(f"rm -rf '{staging}'", check=False)
        raise
    remote_sh(f"stat -c '%s  %n' '{path}/{archive.name}'")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR, metavar="DIR",
                        help=f"Folder with the Y<year>_<band>.geojson files (default: {DEFAULT_INPUT_DIR})")
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT, metavar="PATH",
                        help=f"Output .pmtiles (default: {DEFAULT_OUTPUT.relative_to(HERE)})")
    parser.add_argument("--years", type=parse_years, default=list(DEFAULT_YEARS), metavar="Y,Y",
                        help=f"Years to include (default: {DEFAULT_YEARS[0]}-{DEFAULT_YEARS[-1]})")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Reuse staged GeoJSONs from an earlier run")
    parser.add_argument("--no-build", action="store_true",
                        help="Skip building; upload the existing --output")
    parser.add_argument("--upload", action="store_true", help="Copy the archive to the data hosts")
    parser.add_argument("--remote", action="append", default=None, metavar="HOST:/PATH",
                        help="Upload target, repeatable (default: " + ", ".join(DEFAULT_REMOTES) + ")")
    parser.add_argument("--identity", type=Path, default=None, metavar="KEYFILE",
                        help="ssh private key (default: whatever ~/.ssh/config gives the host)")
    args = parser.parse_args(argv[1:])
    args.years = sorted(set(args.years))

    if args.no_build:
        archive = args.output.resolve()
        if not archive.is_file():
            raise SystemExit(f"error: --no-build but {archive} does not exist")
    else:
        archive = build(args)

    if args.upload:
        for remote in args.remote or DEFAULT_REMOTES:
            upload(archive, remote, args.identity)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
