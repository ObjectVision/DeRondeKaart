#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Build the Nationale Woningbouwkaart PMTiles archive from its upstream source.

Two files on ``nationalewoningbouwkaart.nl`` describe the same 8,166 woningbouw
projects, and both are needed:

    project2.json.gz            points  + every attribute
    project_shape_topo.json.gz  polygons, but only project_id + area codes

They join 1:1 on ``project_id``. The polygons carry no plan name, status or
capacity, so the attributes are copied onto them from the points — otherwise a
click on a plangebied would show an empty popup.

Output is ONE archive holding two layers:

    woningbouw_nl_2026.pmtiles
      woningbouw_punten    8,166 points
      woningbouw_vlakken   8,166 polygons

The map config puts fifteen plain ``format: "pmtiles"`` layers over those two —
the project outlines, plus Hard/Zacht x seven price classes — each a GeoStyler
rule filtering the shared source. One archive, downloaded once, fifteen legend
entries that toggle independently.

Two source quirks decide how properties are written
---------------------------------------------------
**The price columns are sparse, and sometimes zero.** ``Sociale huur`` is present
on 2,986 of 8,166 features and ``Dure koop`` on 83, while ``Middenhuur``,
``Dure huur`` and ``Betaalbare koop`` each have features whose value *is* 0. A
config filter cannot tell "absent" from "zero" through a vector tile, so every
class column is written explicitly, defaulting to 0, and the filters test ``> 0``.

**convert-geojson-to-pmtiles.py lowercases field names.** ``Sociale huur`` would
reach the style as ``sociale huur`` — a property name with a space in it, in every
one of fourteen filters. This script emits snake_case instead, and that field list
is the contract between the archive and ``configs/woonzorglimburg/layers.json``:
change one and the layers render empty, with no error anywhere.

TopoJSON is decoded here rather than through a library: ``transform`` is null in
this source, so arcs already hold absolute lon/lat and all that is needed is arc
stitching. (The quantized path is implemented too, in case upstream turns it on.)

Usage:
    # Fetch, convert, tile
    python3 nationale_woningbouwkaart.py

    # Rebuild from what is already downloaded
    python3 nationale_woningbouwkaart.py --no-download

    # Build and publish
    python3 nationale_woningbouwkaart.py --upload
"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_ROOT = HERE.parent

GEOJSON_TO_PMTILES = DATA_ROOT / "convert-geojson-to-pmtiles.py"

POINTS_URL = "https://nationalewoningbouwkaart.nl/project2.json.gz"
SHAPES_URL = "https://nationalewoningbouwkaart.nl/project_shape_topo.json.gz"

DEFAULT_WORKDIR = HERE / "work" / "woningbouw"
DEFAULT_ARCHIVE = "woningbouw_nl_2026.pmtiles"

POINT_LAYER = "woningbouw_punten"
POLYGON_LAYER = "woningbouw_vlakken"

# The data host behind https://data.woonzorglimburg.nl/pmtiles/.
DEFAULT_REMOTE = "cicada@37.97.169.242:/var/www/woonzorglimburg_data/pmtiles"

# Windows ships OpenSSH here. Prefer it over anything earlier on PATH: the
# MSYS/Git-for-Windows build of ssh cannot talk to the Windows ssh-agent, so it
# fails with "Permission denied (publickey)" while this one authenticates.
WINDOWS_OPENSSH = Path(r"C:\Windows\System32\OpenSSH")

# Points are sparse nationally and the polygons are small; z14 is past the point
# where more depth shows anything a click does not already tell you.
DEFAULT_MINZOOM = 0
DEFAULT_MAXZOOM = 14

# Source field -> the snake_case name written into the tiles. Everything the
# popup and the filters use has to be in here; anything else is dropped to keep
# the tiles small.
DESCRIPTIVE_FIELDS = {
    "project_id": "project_id",
    "Plannaam": "plannaam",
    "Planstatus": "planstatus",
    "peilmoment": "peilmoment",
    "gemeente_naam": "gemeente_naam",
    "provincie_naam": "provincie_naam",
    "Netto Plancapaciteit": "netto_plancapaciteit",
    "Bruto Plancapaciteit": "bruto_plancapaciteit",
}

# The seven price classes, each backing one Hard and one Zacht layer. Written
# even when the source omits them — see the module docstring.
CLASS_FIELDS = {
    "Sociale huur": "sociale_huur",
    "Middenhuur": "middenhuur",
    "Dure huur": "dure_huur",
    "Huur onbekend": "huur_onbekend",
    "Betaalbare koop": "betaalbare_koop",
    "Dure koop": "dure_koop",
    "Koop onbekend": "koop_onbekend",
}


def download(url: str, target: Path, *, skip: bool) -> Path:
    """Fetch ``url`` unless a cached copy is being reused."""
    if skip:
        if not target.is_file():
            raise SystemExit(f"error: --no-download but {target} is not there")
        print(f"  reusing {target.name} ({target.stat().st_size:,} bytes)")
        return target

    print(f"  {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    print(f"  -> {target.name} ({target.stat().st_size:,} bytes)")
    return target


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rb") as handle:
        return json.loads(handle.read())


def properties_of(source: dict) -> dict:
    """The curated snake_case property set for one project."""
    result = {
        target: source.get(name)
        for name, target in DESCRIPTIVE_FIELDS.items()
    }
    for name, target in CLASS_FIELDS.items():
        value = source.get(name)
        # Absent and 0 must be indistinguishable to a "> 0" filter, so both
        # become a written 0 rather than a missing field.
        result[target] = int(value) if isinstance(value, (int, float)) else 0
    return result


def build_points(points: dict, output: Path) -> dict[int, dict]:
    """Write the point layer; return the properties keyed by project_id."""
    by_id: dict[int, dict] = {}
    features = []

    for feature in points["features"]:
        properties = properties_of(feature["properties"])
        project_id = properties["project_id"]
        if project_id is None:
            raise SystemExit("error: a point has no project_id")
        if project_id in by_id:
            raise SystemExit(f"error: duplicate project_id {project_id} in the points")
        by_id[project_id] = properties
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": feature["geometry"],
            }
        )

    write_geojson(output, features)
    return by_id


def decode_arc(arcs: list, transform: dict | None, index: int) -> list:
    """One TopoJSON arc as absolute positions, reversed when the index is negative."""
    forward = index >= 0
    arc = arcs[index if forward else ~index]

    if transform is None:
        positions = [list(point) for point in arc]
    else:
        # Quantized: positions are deltas that have to be accumulated, then
        # scaled and translated back into lon/lat.
        scale_x, scale_y = transform["scale"]
        translate_x, translate_y = transform["translate"]
        x = y = 0
        positions = []
        for delta_x, delta_y in arc:
            x += delta_x
            y += delta_y
            positions.append([x * scale_x + translate_x, y * scale_y + translate_y])

    return positions if forward else positions[::-1]


def stitch_ring(arcs: list, transform: dict | None, indexes: list[int]) -> list:
    """Join a ring's arcs, dropping the vertex each shares with the previous one."""
    ring: list = []
    for position, index in enumerate(indexes):
        points = decode_arc(arcs, transform, index)
        ring.extend(points if position == 0 else points[1:])
    return ring


def topojson_geometry(arcs: list, transform: dict | None, geometry: dict) -> dict | None:
    kind = geometry.get("type")
    if kind == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [stitch_ring(arcs, transform, r) for r in geometry["arcs"]],
        }
    if kind == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [
                [stitch_ring(arcs, transform, r) for r in polygon]
                for polygon in geometry["arcs"]
            ],
        }
    if kind is None:
        return None
    raise SystemExit(f"error: unsupported TopoJSON geometry type: {kind}")


def build_polygons(topology: dict, by_id: dict[int, dict], output: Path) -> int:
    """Write the polygon layer, taking every attribute from the matching point."""
    arcs = topology["arcs"]
    transform = topology.get("transform")

    objects = topology["objects"]
    if len(objects) != 1:
        raise SystemExit(f"error: expected one TopoJSON object, got {list(objects)}")
    collection = next(iter(objects.values()))

    features = []
    skipped = 0
    for geometry in collection["geometries"]:
        project_id = geometry.get("properties", {}).get("project_id")
        if project_id not in by_id:
            raise SystemExit(
                f"error: polygon {project_id!r} has no matching point — "
                "the two sources are out of step, do not publish this build"
            )
        shape = topojson_geometry(arcs, transform, geometry)
        if shape is None:
            skipped += 1
            continue
        features.append(
            {"type": "Feature", "properties": by_id[project_id], "geometry": shape}
        )

    if skipped:
        print(f"  {skipped} geometry/geometries had no shape and were left out")

    write_geojson(output, features)
    return len(features)


def write_geojson(output: Path, features: list[dict]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf8") as handle:
        json.dump(
            {"type": "FeatureCollection", "features": features},
            handle,
            ensure_ascii=False,
        )
    print(f"  {output.name}: {len(features):,} features ({output.stat().st_size:,} bytes)")


def run_converter(points: Path, polygons: Path, archive: Path, args) -> None:
    """One archive, one layer per input — names passed explicitly to keep casing."""
    command = [
        sys.executable,
        str(GEOJSON_TO_PMTILES),
        "--layer",
        f"{POINT_LAYER}={points}",
        "--layer",
        f"{POLYGON_LAYER}={polygons}",
        "-o",
        str(archive),
        "--minzoom",
        str(args.minzoom),
        "--maxzoom",
        str(args.maxzoom),
    ]
    result = subprocess.run(command, check=False, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: tiling failed (exit {result.returncode})")


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
    result = subprocess.run(
        [ssh, "-o", "BatchMode=yes", host, script], check=False, text=True
    )
    if result.returncode != 0:
        raise SystemExit(f"error: remote command failed (exit {result.returncode})")


def run_ssh_quietly(ssh: str, host: str, script: str) -> None:
    """Best-effort cleanup — the failure that got us here is the one to report."""
    subprocess.run(
        [ssh, "-o", "BatchMode=yes", host, script],
        check=False,
        capture_output=True,
        text=True,
    )


def upload(archive: Path, remote: str) -> None:
    """Copy the archive to the data host, swapping it in from a staging folder.

    scp writes straight into the destination file, so copying over the live
    archive would let a viewer range-read a truncated one for as long as the
    transfer lasts — which shows up as a blank layer, not as an error.
    """
    ssh = resolve_ssh_tool("ssh")
    scp = resolve_ssh_tool("scp")
    host, path = split_remote(remote)
    staging = f"{path}/.staging-{time.strftime('%Y%m%d-%H%M%S')}"

    print(f"\nUploading {archive.name} ({archive.stat().st_size:,} bytes) -> {remote}")

    run_ssh(ssh, host, f"mkdir -p '{staging}'")
    try:
        command = [scp, "-o", "BatchMode=yes", str(archive), f"{host}:{staging}/"]
        result = subprocess.run(command, check=False, text=True)
        if result.returncode != 0:
            raise SystemExit(f"error: scp failed (exit {result.returncode})")

        run_ssh(
            ssh,
            host,
            f"chmod 644 '{staging}/{archive.name}' && "
            f"mv '{staging}/{archive.name}' '{path}/' && rmdir '{staging}'",
        )
    except BaseException:
        run_ssh_quietly(ssh, host, f"rm -rf '{staging}'")
        raise

    print("Upload done. Remote:")
    run_ssh(ssh, host, f"stat -c '%s  %y  %n' '{path}/{archive.name}'")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build the Nationale Woningbouwkaart PMTiles archive (points + project "
            "polygons) from nationalewoningbouwkaart.nl."
        ),
    )
    parser.add_argument(
        "--workdir",
        default=str(DEFAULT_WORKDIR),
        metavar="PATH",
        help=f"Where downloads and intermediates live (default: {DEFAULT_WORKDIR})",
    )
    parser.add_argument(
        "--archive",
        default=DEFAULT_ARCHIVE,
        metavar="NAME",
        help=f"Archive file name (default: {DEFAULT_ARCHIVE})",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Reuse the .gz files already in the work dir",
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
        "--upload",
        action="store_true",
        help="Publish the archive to the data host once it is built",
    )
    parser.add_argument(
        "--remote",
        default=DEFAULT_REMOTE,
        metavar="USER@HOST:/PATH",
        help=f"Upload destination (default: {DEFAULT_REMOTE})",
    )
    args = parser.parse_args(argv[1:])

    if not GEOJSON_TO_PMTILES.is_file():
        print(f"error: missing converter: {GEOJSON_TO_PMTILES}", file=sys.stderr)
        return 2

    workdir = Path(args.workdir)
    if not workdir.is_absolute():
        workdir = (Path.cwd() / workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)

    started = time.time()

    print("Source")
    points_gz = download(POINTS_URL, workdir / "project2.json.gz", skip=args.no_download)
    shapes_gz = download(
        SHAPES_URL, workdir / "project_shape_topo.json.gz", skip=args.no_download
    )

    print("\nPoints")
    points_json = workdir / f"{POINT_LAYER}.geojson"
    by_id = build_points(read_gzip_json(points_gz), points_json)

    print("\nPolygons")
    polygons_json = workdir / f"{POLYGON_LAYER}.geojson"
    polygon_count = build_polygons(read_gzip_json(shapes_gz), by_id, polygons_json)
    if polygon_count != len(by_id):
        print(
            f"  note: {len(by_id):,} points vs {polygon_count:,} polygons — "
            "not every project has a shape"
        )

    print("\nTiling")
    archive = workdir / args.archive
    run_converter(points_json, polygons_json, archive, args)

    if not archive.is_file():
        raise SystemExit(f"error: {archive} was not written")
    with archive.open("rb") as handle:
        if handle.read(7) != b"PMTiles":
            raise SystemExit(f"error: {archive.name} is not a PMTiles archive")

    print(
        f"\nDone in {time.time() - started:.0f}s — {archive} "
        f"({archive.stat().st_size:,} bytes)"
    )

    if args.upload:
        upload(archive, args.remote)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
