#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["gdal"]
# ///
"""Regenerate the merged dataset archives published at data.startanalyse2026.nl/downloads/.

Each archive (``stratLN.zip``, ``LNGA.zip``, ``strat1.zip`` ... ``ref30.zip``)
holds both model years side by side, one directory per year::

    2025/strat1.gpkg              GeoPackage, the dataset the QGIS project opens
    2025/strat1.csv               attributes only, no geometry
    2025/strat1.qgs               QGIS project styled like the web app
    2025/strat1.mapx              the same as an ArcGIS Pro map (Insert > Import Map)
    2025/LEESMIJ-ArcGIS.txt       how to open the .mapx
    2025/shapefile/strat1.shp     the same data as a shapefile (+ .dbf .shx .prj .cpg)
    2025/shapefile/strat1_veldnamen.csv
                                  shapefile field name -> full field name
    2026/...

Everything is rebuilt from the model's GeoJSON output, one folder per year
(``C:/LocalData/startanalyse_2_0/<year>/*.geojson`` by default). The QGIS
projects come from ``build-qgis-projects.py`` and the ArcGIS Pro maps from
``build-arcgis-maps.py``; both read the styling from
``configs/startanalyse2026/<year>/layers.json`` at build time -- so a project
always matches the layers config it was built against.

Two GeoJSON stems are published under another name: ``ref19`` is the 2023
reference, published as ``ref23`` (its pmtiles source kept the old name), and
2025's ``stratNL`` is ``stratLN``. GeoJSON with no archive on the server (the
2025 per-strategy sensitivity runs ``S1GA03`` ...) is skipped.

The GeoPackages keep the layout of the archives published before: one table
``sa2023strat``, geometry column ``geom``, MultiPolygon in EPSG:28992.

Outputs land in ``data/downloads-merged/<archive>.zip``, with each project also
copied to ``data/downloads-qgs/<year>/`` and its CRC recorded in
``data/downloads-qgs/published-qgs-crc.json``.

Usage::

    python data/generate_merged_startanalyse2026_downloads.py
    python data/generate_merged_startanalyse2026_downloads.py --only strat1
    python data/generate_merged_startanalyse2026_downloads.py --upload \\
        --remote cicada@149.210.181.180:/var/www/startanalyse2026_data/downloads

On Windows, Git Bash's ``ssh`` does not see the Windows ssh-agent key; pass
``--ssh C:/Windows/System32/OpenSSH/ssh.exe --scp C:/Windows/System32/OpenSSH/scp.exe``.
"""

from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from osgeo import gdal, ogr

gdal.UseExceptions()

DATA_DIR = Path(__file__).resolve().parent
YEARS = ("2025", "2026")

# The archives the server publishes, in the order the app lists them.
ARCHIVES = ("stratLN", "LNGA", "strat1", "strat2", "strat3", "strat4", "ref23", "ref30")

# GeoJSON stem -> published stem, where the two differ.
PUBLISHED_STEM = {"ref19": "ref23", "stratNL": "stratLN"}

# The table name every published GeoPackage has carried. Kept so a reader's own
# QGIS project pointing at `|layername=sa2023strat` survives a data refresh.
GPKG_LAYER = "sa2023strat"

SHAPEFILE_PARTS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


# Shipped beside each .mapx: importing a map file is not a double-click.
ARCGIS_README_NAME = "LEESMIJ-ArcGIS.txt"
ARCGIS_README_TEXT = """\
Openen in ArcGIS Pro
====================

Het .mapx-bestand in deze map is een ArcGIS Pro-kaart met dezelfde lagen,
kleuren en indeling als De Ronde Kaart. De lagen lezen de GeoPackage(s)
(.gpkg) in deze zelfde map.

1. Pak het zip-bestand helemaal uit. Laat .mapx en .gpkg bij elkaar staan.
2. Open of maak een project in ArcGIS Pro (3.0 of nieuwer).
3. Kies Insert > Import Map en selecteer het .mapx-bestand.
4. Alle lagen staan uit; vink een laag aan om hem te tonen.

Tonen de lagen een rood uitroepteken? Klik dan met rechts op een laag, kies
Data > Repair Data Source en wijs het .gpkg-bestand in deze map aan. ArcGIS Pro
herstelt daarmee in een keer alle lagen die naar dezelfde GeoPackage verwijzen.
"""


def archive_of(stem: str) -> str | None:
    if re.fullmatch(r"LNGA\d\d", stem):
        return "LNGA"
    return stem if stem in ARCHIVES else None


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


def feature_count(path: Path) -> int:
    ds = ogr.Open(str(path))
    try:
        return ds.GetLayer(0).GetFeatureCount()
    finally:
        ds = None


def field_names(path: Path) -> list[str]:
    ds = ogr.Open(str(path))
    try:
        defn = ds.GetLayer(0).GetLayerDefn()
        return [defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())]
    finally:
        ds = None


def to_gpkg(src: Path, dst: Path) -> None:
    gdal.VectorTranslate(
        str(dst), str(src), format="GPKG", layerName=GPKG_LAYER,
        # The GeoJSON mixes Polygon and MultiPolygon features. One declared type
        # matters: build-qgis-projects.py reads it as the layer's wkbType, and a
        # narrower one than the data drops features without an error.
        geometryType="PROMOTE_TO_MULTI", dstSRS="EPSG:28992",
        layerCreationOptions=["GEOMETRY_NAME=geom", "FID=fid", "SPATIAL_INDEX=YES"],
    )


def to_csv(src: Path, dst: Path) -> None:
    # No GEOMETRY option: the CSV is the attribute table only, as before.
    gdal.VectorTranslate(
        str(dst), str(src), format="CSV", layerCreationOptions=["LINEFORMAT=LF"],
    )


def to_shapefile(src: Path, dst: Path) -> Path:
    """Write the shapefile and the field-name key that makes it readable.

    DBF caps field names at 10 characters, and GDAL resolves the clashes that
    truncation causes (six `H17_perc_*` columns all start `H17_perc_d`) with
    numbered names that say nothing. The key maps each one back.
    """
    # Quiet: GDAL warns once per laundered name, and the key below says it all.
    gdal.PushErrorHandler("CPLQuietErrorHandler")
    try:
        gdal.VectorTranslate(
            str(dst), str(src), format="ESRI Shapefile",
            geometryType="PROMOTE_TO_MULTI", dstSRS="EPSG:28992",
            layerCreationOptions=["ENCODING=UTF-8"],
        )
    finally:
        gdal.PopErrorHandler()
    full = field_names(src)
    short = field_names(dst)
    if len(full) != len(short) or len(set(short)) != len(short):
        raise AssertionError(f"{dst.name}: field names did not map one to one")
    key = dst.with_name(dst.stem + "_veldnamen.csv")
    with key.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["veldnaam_shapefile", "veldnaam"])
        writer.writerows(zip(short, full))
    return key


def convert(src: Path, out_dir: Path, stem: str) -> list[Path]:
    """All published forms of one GeoJSON; returns the files in archive order."""
    out_dir.mkdir(parents=True, exist_ok=True)
    shp_dir = out_dir / "shapefile"
    shp_dir.mkdir(exist_ok=True)

    gpkg, csv_path, shp = out_dir / f"{stem}.gpkg", out_dir / f"{stem}.csv", shp_dir / f"{stem}.shp"
    for p in (gpkg, csv_path, *(shp.with_suffix(s) for s in SHAPEFILE_PARTS)):
        p.unlink(missing_ok=True)

    to_gpkg(src, gpkg)
    to_csv(src, csv_path)
    key = to_shapefile(src, shp)

    expected = feature_count(src)
    for p in (gpkg, shp):
        got = feature_count(p)
        if got != expected:
            raise AssertionError(f"{p.name}: {got} features, source has {expected}")
    with csv_path.open(encoding="utf-8") as fh:
        rows = sum(1 for _ in csv.reader(fh)) - 1
    if rows != expected:
        raise AssertionError(f"{csv_path.name}: {rows} rows, source has {expected}")

    return [gpkg, csv_path, *(shp.with_suffix(s) for s in SHAPEFILE_PARTS), key]


# ---------------------------------------------------------------------------
# Archives
# ---------------------------------------------------------------------------


def write_zip(path: Path, entries: list[tuple[str, Path]]) -> None:
    tmp = path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, src in entries:
            zf.write(src, arcname)
    tmp.replace(path)


def qgs_crcs(zips: dict[str, Path]) -> dict[str, dict[str, int]]:
    crcs: dict[str, dict[str, int]] = {}
    for zpath in zips.values():
        with zipfile.ZipFile(zpath) as zf:
            for info in zf.infolist():
                year, _, name = info.filename.partition("/")
                if name.endswith(".qgs") and "/" not in name:
                    crcs.setdefault(year, {})[name] = info.CRC
    return {y: dict(sorted(v.items())) for y, v in sorted(crcs.items())}


def upload(zips: dict[str, Path], remote: str, ssh: str, scp: str) -> None:
    """Copy the archives up, then swap them in.

    Each archive lands in a staging directory first and is moved into place
    only once every upload has finished, so a dropped connection never leaves
    the site serving a half-written zip. The archives replaced are kept in a
    timestamped directory under the remote user's home: anywhere under the web
    root would be served, and the site has autoindex on.
    """
    host, _, target = remote.partition(":")
    if not host or not target:
        raise SystemExit(f"--remote must be host:/path, got {remote!r}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    staging = f"{target}/.upload-{stamp}"
    # Double-quoted wherever it is used, so the remote shell expands $HOME.
    backup = f"$HOME/downloads-previous/{stamp}"

    subprocess.run([ssh, host, f"mkdir -p '{staging}' \"{backup}\""], check=True)
    for name, path in zips.items():
        print(f"  uploading {name}.zip ({path.stat().st_size / 2**20:.0f} MB)")
        subprocess.run([scp, "-q", str(path), f"{host}:{staging}/{name}.zip"], check=True)

    names = " ".join(f"{n}.zip" for n in zips)
    swap = (
        f"set -e; cd '{target}'; "
        f"for f in {names}; do "
        f"  if [ -f \"$f\" ]; then cp -p \"$f\" \"{backup}/\"; fi; "
        f"  chmod 664 '{staging}'/\"$f\"; mv '{staging}'/\"$f\" \"$f\"; "
        f"done; rmdir '{staging}'; ls -la '{target}'"
    )
    subprocess.run([ssh, host, swap], check=True)
    print(f"  previous archives kept on the server in {backup}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-dir", type=Path, default=Path("C:/LocalData/startanalyse_2_0"),
                        help="Holds <year>/*.geojson")
    parser.add_argument("--work-dir", type=Path,
                        help="Scratch space for converted files (default: a temp dir)")
    parser.add_argument("--out-dir", type=Path, default=DATA_DIR / "downloads-merged",
                        help="Receives <archive>.zip")
    parser.add_argument("--qgs-dir", type=Path, default=DATA_DIR / "downloads-qgs",
                        help="Receives <year>/<archive>.qgs and published-qgs-crc.json")
    parser.add_argument("--only", help="Only archives matching this glob, e.g. 'strat*'")
    parser.add_argument("--upload", action="store_true", help="Publish the archives when built")
    parser.add_argument("--remote", default="cicada@149.210.181.180:/var/www/startanalyse2026_data/downloads",
                        help="host:/path the archives are published to")
    parser.add_argument("--ssh", default="ssh")
    parser.add_argument("--scp", default="scp")
    args = parser.parse_args()

    archives = [a for a in ARCHIVES if not args.only or fnmatch.fnmatch(a, args.only)]
    if not archives:
        print(f"no archive matches {args.only!r}", file=sys.stderr)
        return 1

    work = args.work_dir or Path(tempfile.mkdtemp(prefix="sa2026-downloads-"))
    gpkg_root = work / "data"
    qgs_root = work / "qgs"
    mapx_root = work / "mapx"

    # archive -> year -> files in archive order
    contents: dict[str, dict[str, list[Path]]] = {a: {} for a in archives}

    for year in YEARS:
        sources = sorted((args.source_dir / year).glob("*.geojson"))
        if not sources:
            print(f"no GeoJSON in {args.source_dir / year}", file=sys.stderr)
            return 1
        for src in sources:
            stem = PUBLISHED_STEM.get(src.stem, src.stem)
            archive = archive_of(stem)
            if archive is None:
                print(f"  {year}/{src.name}: no published archive, skipped")
                continue
            if archive not in contents:
                continue
            print(f"  {year}/{src.name} -> {archive}.zip/{year}/{stem}.*")
            files = convert(src, gpkg_root / year / archive, stem)
            contents[archive].setdefault(year, []).extend(files)

    # The QGIS projects and ArcGIS Pro maps, styled from the current
    # layers.json of each year.
    for builder, out in (("build-qgis-projects.py", qgs_root), ("build-arcgis-maps.py", mapx_root)):
        cmd = [sys.executable, str(DATA_DIR / builder),
               "--gpkg-dir", str(gpkg_root), "--out-dir", str(out)]
        if args.only:
            cmd += ["--only", args.only]
        subprocess.run(cmd, check=True)
    readme = work / ARCGIS_README_NAME
    readme.write_text(ARCGIS_README_TEXT, encoding="utf-8")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    zips: dict[str, Path] = {}
    for archive in archives:
        entries: list[tuple[str, Path]] = []
        for year in YEARS:
            files = contents[archive].get(year)
            if not files:
                print(f"  {archive}: no {year} data", file=sys.stderr)
                return 1
            data_files = [f for f in files if f.parent.name != "shapefile"]
            shp_files = [f for f in files if f.parent.name == "shapefile"]
            entries += [(f"{year}/{f.name}", f) for f in data_files]
            qgs = qgs_root / year / f"{archive}.qgs"
            # A year whose layers.json styles nothing from this archive (2026
            # dropped strategy 4 from the app) ships the data without a project.
            if qgs.is_file():
                entries.append((f"{year}/{qgs.name}", qgs))
                dest = args.qgs_dir / year / qgs.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(qgs, dest)
                mapx = mapx_root / year / f"{archive}.mapx"
                entries.append((f"{year}/{mapx.name}", mapx))
                entries.append((f"{year}/{readme.name}", readme))
            else:
                print(f"  {year}/{archive}: no styled layers, archive has no .qgs/.mapx")
                (args.qgs_dir / year / f"{archive}.qgs").unlink(missing_ok=True)
            entries += [(f"{year}/shapefile/{f.name}", f) for f in shp_files]
        zpath = args.out_dir / f"{archive}.zip"
        write_zip(zpath, entries)
        zips[archive] = zpath
        print(f"  {zpath.name}: {len(entries)} files, {zpath.stat().st_size / 2**20:.1f} MB")

    # The CRC file covers every published archive, so merge rather than
    # overwrite when only some were rebuilt.
    crc_path = args.qgs_dir / "published-qgs-crc.json"
    all_zips = {p.stem: p for p in sorted(args.out_dir.glob("*.zip")) if p.stem in ARCHIVES}
    crc_path.write_text(json.dumps(qgs_crcs(all_zips), indent=2) + "\n", encoding="utf-8")

    if args.upload:
        upload(zips, args.remote, args.ssh, args.scp)

    if not args.work_dir:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
