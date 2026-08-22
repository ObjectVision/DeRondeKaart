#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Build ONE PMTiles archive per Startanalyse dataset.

``geojson/startanalyse2026/<year>/`` holds one GeoJSON per strategy variant
(``strat1``, ``stratNL``, ``ref19``, ``LNGA01``…, ``S1GA03``…). This driver runs
``convert-geojson-to-pmtiles.py`` once per file:

    geojson/startanalyse2026/2025/strat1.geojson
      -> pmtiles/startanalyse2026/2025/strat1.pmtiles   (one layer: "strat1")

**One archive per dataset, deliberately** — the opposite of what
``build-years-pmtiles.py`` does, and worth explaining. Those year rasters are
different measures on the same grid that the map animates *through*, so sharing
one archive means one warm cache while stepping years. These files are not like
that: all ~46 of them carry the *same* 14.5k CBS buurt polygons, differing only
in attribute values, and the map shows one at a time. Bundling them would put 46
copies of every polygon in each tile, and since ``tileSourceId()``
(``src/hooks/use-map-layers.ts``) keys a MapLibre source on the layer id rather
than the archive URL, a viewer showing one dataset would download and parse all
46. It would also breach the driver's ``MAX_SIZE`` tile budget at low zoom,
where features are dropped silently to fit.

Layers are named with ``--layer <stem>=<file>`` rather than by letting the
converter infer them: its single-file mode lowercases the file stem, which would
turn ``LNGA01`` into ``lnga01`` and break the ``sourceLayer`` values in
``configs/startanalyse2026/layers.json``.

``--unquote`` is always passed: the GeoDMS export writes string values with
literal quotes (``"'s1a'"``, ``"'RES Flevoland'"``).

Needs the GDAL Python bindings (``osgeo``), which on Windows come from OSGeo4W
and not from pip. The script looks for an interpreter that has them, starting
with the current one and falling back to ``C:\\OSGeo4W\\bin\\python-qgis.bat``.

With ``--upload`` the built archives are copied to the data host that serves
``https://data.startanalyse2026.nl/pmtiles/``. They go to a staging folder first
and are moved into place in one step, so a viewer never range-reads a half
written archive. There is no rollback copy — a bad build overwrites the good
one, so check a rebuild locally before uploading it.

Usage:
    # Every dataset of the default year
    python3 build-startanalyse-pmtiles.py

    # Rebuild from a fresh GeoDMS export and publish it
    python3 build-startanalyse-pmtiles.py --srcdir C:\\LocalData\\startanalyse_2_0\\2025 --upload

    # One dataset (or a glob) — for tuning zooms without a 46-file rebuild
    python3 build-startanalyse-pmtiles.py --only strat1
    python3 build-startanalyse-pmtiles.py --only "LNGA*"

    # Resume an interrupted run
    python3 build-startanalyse-pmtiles.py --skip-existing

    # Publish what is already built, without rebuilding
    python3 build-startanalyse-pmtiles.py --skip-existing --upload
"""
from __future__ import annotations

import argparse
import fnmatch
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEOJSON_ROOT = HERE / "geojson" / "startanalyse2026"
PMTILES_ROOT = HERE / "pmtiles" / "startanalyse2026"

GEOJSON_TO_PMTILES = HERE / "convert-geojson-to-pmtiles.py"

# Where OSGeo4W puts its interpreter on Windows. Only used as a fallback when
# the current one has no GDAL bindings.
OSGEO4W_PYTHON = Path(r"C:\OSGeo4W\bin\python-qgis.bat")

# The data host behind https://data.startanalyse2026.nl/pmtiles/.
DEFAULT_REMOTE = "cicada@149.210.181.180:/var/www/startanalyse2026_data/pmtiles"

# Windows ships OpenSSH here. Prefer it over anything earlier on PATH: the
# MSYS/Git-for-Windows build of ssh cannot talk to the Windows ssh-agent, so it
# fails with "Permission denied (publickey)" while this one authenticates.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

GEOJSON_SUFFIXES = (".geojson", ".json")

DEFAULT_YEAR = "2025"

# Buurt polygons: z13 is already past the point where more depth adds visible
# detail (MapLibre overzooms beyond a source's maxzoom), and every extra level
# roughly quadruples the tile count. The raised MAX_SIZE keeps the low-zoom
# tiles — where all 14.5k buurten land in one tile — from having features
# dropped to fit the driver's 500 KB default.
DEFAULT_MINZOOM = 0
DEFAULT_MAXZOOM = 13
DEFAULT_MAX_SIZE = 2_000_000


def has_module(interpreter: list[str], module: str) -> bool:
    """Whether ``interpreter`` can import ``module``."""
    result = subprocess.run(
        interpreter + ["-c", f"import {module}"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def resolve_interpreter() -> list[str]:
    """Find an interpreter with the GDAL bindings, preferring the current one."""
    candidates = [[sys.executable]]

    if OSGEO4W_PYTHON.is_file():
        candidates.append([str(OSGEO4W_PYTHON)])
    for name in ("python-qgis.bat", "python3.exe", "python.exe"):
        found = shutil.which(name)
        if found and [found] not in candidates:
            candidates.append([found])

    interpreter = next((c for c in candidates if has_module(c, "osgeo")), None)
    if interpreter is None:
        raise SystemExit(
            "error: no interpreter found with the GDAL bindings (osgeo).\n"
            f"  Windows/OSGeo4W:  expected {OSGEO4W_PYTHON}\n"
            "  conda:            conda install -c conda-forge gdal"
        )

    print(f"PMTiles with: {Path(interpreter[0]).name}")
    return interpreter


def collect(year_dir: Path, pattern: str | None) -> list[Path]:
    """Every GeoJSON in the year folder, optionally filtered by a glob."""
    if not year_dir.is_dir():
        raise SystemExit(f"error: year folder not found: {year_dir}")

    files = sorted(
        p
        for p in year_dir.iterdir()
        if p.is_file() and p.suffix.lower() in GEOJSON_SUFFIXES
    )
    if pattern:
        files = [p for p in files if fnmatch.fnmatch(p.stem, pattern)]
        if not files:
            raise SystemExit(f"error: --only {pattern!r} matched nothing in {year_dir}")
    if not files:
        raise SystemExit(f"error: no .geojson/.json files in {year_dir}")

    return files


def build_one(
    geojson: Path,
    output: Path,
    *,
    interpreter: list[str],
    minzoom: int,
    maxzoom: int,
    max_size: int,
    simplification: float | None,
) -> None:
    """Run the converter for one dataset, layer named after the file stem."""
    command = interpreter + [
        str(GEOJSON_TO_PMTILES),
        # NAME=PATH is split at the FIRST '=', so Windows paths stay intact.
        # The stem is passed verbatim to keep its casing (LNGA01, not lnga01).
        "--layer",
        f"{geojson.stem}={geojson}",
        "-o",
        str(output),
        "--unquote",
        "--minzoom",
        str(minzoom),
        "--maxzoom",
        str(maxzoom),
        "--max-size",
        str(max_size),
    ]
    if simplification is not None:
        command += ["--simplification", str(simplification)]

    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"error: building {output.name} failed (exit {result.returncode})"
        )


def resolve_ssh_tool(name: str) -> str:
    """Locate an OpenSSH binary, preferring the one Windows ships."""
    if sys.platform == "win32":
        bundled = WINDOWS_OPENSSH / f"{name}.exe"
        if bundled.is_file():
            return str(bundled)

    found = shutil.which(name)
    if found is None:
        raise SystemExit(f"error: {name} not found on PATH — cannot upload")
    return found


def split_remote(remote: str) -> tuple[str, str]:
    """``user@host:/path`` -> ``("user@host", "/path")``."""
    host, separator, path = remote.partition(":")
    if not separator or not path:
        raise SystemExit(
            f"error: --remote must look like user@host:/path, got {remote!r}"
        )
    return host, path.rstrip("/")


def run_ssh(ssh: str, host: str, script: str) -> None:
    """Run a shell snippet on the data host."""
    result = subprocess.run([ssh, host, script], check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: remote command failed (exit {result.returncode})")


def upload(files: list[Path], remote: str) -> None:
    """Copy archives to the data host, swapping them in from a staging folder.

    scp writes straight into the destination file, so copying over a live
    archive would let a viewer range-read a truncated one for the minute or so
    the transfer lasts. Staging plus a ``mv`` on the same filesystem makes each
    replacement a rename instead.
    """
    ssh = resolve_ssh_tool("ssh")
    scp = resolve_ssh_tool("scp")
    host, path = split_remote(remote)
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    total = sum(p.stat().st_size for p in files)
    print(f"\nUploading {len(files)} archive(s), {total:,} bytes -> {remote}")

    run_ssh(ssh, host, f"mkdir -p '{staging}'")
    try:
        command = [scp, *(str(p) for p in files), f"{host}:{staging}/"]
        result = subprocess.run(command, check=False, text=True)
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")

        # One mv per archive, then drop the staging folder. Not atomic across
        # the set — a viewer mid-swap can see a mix of old and new — but each
        # individual archive is always complete.
        run_ssh(ssh, host, f"mv '{staging}'/*.pmtiles '{path}/' && rmdir '{staging}'")
    except BaseException:
        run_ssh_quietly(ssh, host, f"rm -rf '{staging}'")
        raise

    print("Upload done. Remote sizes:")
    names = " ".join(f"'{path}/{p.name}'" for p in files)
    run_ssh(ssh, host, f"stat -c '%s  %y  %n' {names}")


def run_ssh_quietly(ssh: str, host: str, script: str) -> None:
    """Best-effort cleanup — the failure that got us here is the one to report."""
    subprocess.run([ssh, host, script], check=False, capture_output=True, text=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build one PMTiles archive per Startanalyse dataset, each holding a "
            "single layer named after the source file."
        ),
    )
    parser.add_argument(
        "--year",
        default=DEFAULT_YEAR,
        metavar="YYYY",
        help=f"Year folder under {GEOJSON_ROOT.name}/ (default: {DEFAULT_YEAR})",
    )
    parser.add_argument(
        "--srcdir",
        default=None,
        metavar="PATH",
        help=(
            "Folder holding the GeoJSON exports "
            f"(default: {GEOJSON_ROOT}/<year>). Use this to build straight from "
            "a GeoDMS export without copying it into the repo tree."
        ),
    )
    parser.add_argument(
        "--only",
        default=None,
        metavar="GLOB",
        help="Build only the datasets whose stem matches this glob (e.g. 'LNGA*')",
    )
    parser.add_argument(
        "--outdir",
        default=None,
        metavar="PATH",
        help=f"Output folder (default: {PMTILES_ROOT}/<year>)",
    )
    parser.add_argument(
        "--minzoom",
        type=int,
        default=DEFAULT_MINZOOM,
        metavar="Z",
        help=f"Lowest zoom level to build (default: {DEFAULT_MINZOOM})",
    )
    parser.add_argument(
        "--maxzoom",
        type=int,
        default=DEFAULT_MAXZOOM,
        metavar="Z",
        help=f"Highest zoom level to build (default: {DEFAULT_MAXZOOM})",
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=DEFAULT_MAX_SIZE,
        metavar="BYTES",
        help=f"Maximum tile size before features are dropped (default: {DEFAULT_MAX_SIZE})",
    )
    parser.add_argument(
        "--simplification",
        type=float,
        default=None,
        metavar="N",
        help="Geometry simplification factor applied below the max zoom",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Leave archives that already exist alone instead of rebuilding them",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Publish the archives to the data host once they are all built",
    )
    parser.add_argument(
        "--remote",
        default=DEFAULT_REMOTE,
        metavar="USER@HOST:/PATH",
        help=f"Upload destination (default: {DEFAULT_REMOTE})",
    )
    args = parser.parse_args(argv[1:])

    if not GEOJSON_TO_PMTILES.is_file():
        print(f"error: missing sibling script: {GEOJSON_TO_PMTILES}", file=sys.stderr)
        return 2

    year_dir = Path(args.srcdir) if args.srcdir else GEOJSON_ROOT / args.year
    if not year_dir.is_absolute():
        year_dir = (Path.cwd() / year_dir).resolve()
    outdir = Path(args.outdir) if args.outdir else PMTILES_ROOT / args.year
    if not outdir.is_absolute():
        outdir = (Path.cwd() / outdir).resolve()

    files = collect(year_dir, args.only)
    print(f"Found {len(files)} dataset(s) in {year_dir}")

    interpreter = resolve_interpreter()
    outdir.mkdir(parents=True, exist_ok=True)

    started = time.time()
    built: list[Path] = []
    skipped = 0

    for index, geojson in enumerate(files, start=1):
        output = outdir / f"{geojson.stem}.pmtiles"
        print(f"\n[{index}/{len(files)}] {geojson.stem}")

        if args.skip_existing and output.is_file():
            print(f"  reusing {output.name} ({output.stat().st_size:,} bytes)")
            built.append(output)
            skipped += 1
            continue

        build_one(
            geojson,
            output,
            interpreter=interpreter,
            minzoom=args.minzoom,
            maxzoom=args.maxzoom,
            max_size=args.max_size,
            simplification=args.simplification,
        )
        built.append(output)

    elapsed = time.time() - started
    total = sum(p.stat().st_size for p in built if p.is_file())
    print(
        f"\nDone in {elapsed:.0f}s — {len(built)} archive(s) in {outdir} "
        f"({total:,} bytes total)"
        + (f", {skipped} reused" if skipped else "")
    )

    if args.upload:
        upload([p for p in built if p.is_file()], args.remote)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
