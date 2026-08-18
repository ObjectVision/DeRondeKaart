#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "numpy>=1.24",
#   "rasterio>=1.3",
#   "rio-cogeo>=5",
# ]
# ///
"""Burn one attribute of a GeoJSON into a class COG **on an existing grid**.

This is the vector-source counterpart of ``convert-tif-to-cog-10m.py``. Use it
when a layer is drawn from vector data but has to take part in the app's
"combineer lagen" scoring, which reads a companion single-band class raster per
layer (``LayerConfig.filterRaster``) and counts, cell by cell, how many layers
matched — see ``src/layers/filter-raster.ts``.

Why ``--like`` instead of a resolution
--------------------------------------
Scoring is plain array arithmetic over co-registered cells, so
``computeScoreGrid`` refuses to combine rasters whose overview size or bounding
box differ. It is not enough to pick the same CRS and resolution as the existing
set: the *extent* has to match too, and a vector file's own bounds are whatever
the data happens to cover. Rasterising straight into a reference raster's
transform and shape makes co-registration true by construction rather than by
coincidence, which is why ``--like`` is required and has no default.

The reference for this project is the WebMercatorQuad zoom-14 grid the whole
``cog/comparison`` set already uses: EPSG:3857, 7168x19712, 9.5546 units/px
(~6.0 m ground at Limburg's latitude). The header of
``convert-tif-to-cog-10m.py`` explains why "10m" is nominal and why a true 10 m
grid is impossible for a raster this renderer will accept.

Source geometry that falls outside the reference extent is clipped, and the
reference extent not covered by geometry becomes nodata. Both are reported.

Class values
------------
The burned cell value **is** the value the layer's GeoStyler rules test:
``filterProperties`` in ``filter-raster.ts`` binds each cell to the attribute
names the filter reads, so a rule written as ``["==", "COMBI1824", 3]`` matches
a cell holding 3 with no config or code change. That correspondence is what
``--match-rules`` checks mechanically.

Features whose attribute is missing or outside 0..254 are skipped rather than
cast. This matters: these datasets use ``-9`` as a "no measurement" sentinel,
and ``-9`` in a uint8 array wraps to 247 — a bogus class no rule matches, which
would show up only as a quietly wrong score.

Usage:
    python3 convert-geojson-to-cog-10m.py geojson/VKRLimburgnative.geojson \\
        --property COMBI1824 \\
        --like tif/huisarts_lb_m5.cog.tif \\
        tif/veerkracht_limburg.cog.tif

    # Also assert the burned values line up with the layer's GeoStyler rules
    python3 convert-geojson-to-cog-10m.py geojson/VKRLimburgnative.geojson \\
        --property FOCUS24 --like tif/huisarts_lb_m5.cog.tif \\
        tif/focus_limburg.cog.tif \\
        --match-rules ../configs/woonzorglimburg/layers.json \\
        --layer-id focus_limburg
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.io import MemoryFile
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

# Nodata sentinel shared by the whole cog/comparison set and hard-coded as
# `NODATA` in src/layers/filter-raster.ts, where it is the value the scorer
# skips outright. Also caps the usable class range at 0..254.
NODATA = 255

# Yields overview factors [2, 4, 8, 16], matching every published raster in
# cog/comparison. The count is not cosmetic: computeScoreGrid opens image index
# min(2, count - 1) of each input, so a file with a different number of
# overviews resolves that index to a different factor and fails the size check.
DEFAULT_OVERVIEW_LEVEL = 4

# describe_grid/check_grid are duplicated from convert-tif-to-cog-10m.py rather
# than imported: every script in this folder is a self-contained PEP 723 script
# runnable from anywhere, and the sibling's hyphenated filename is not
# importable as a module. Keep the two copies in step.


def describe_grid(path: Path) -> tuple[object, object, tuple[int, int]]:
    """Read the three properties that define a raster's grid."""
    with rasterio.open(path) as src:
        return src.crs, src.transform, (src.width, src.height)


def check_grid(output_path: Path, reference_path: Path) -> bool:
    """Assert ``output_path`` is co-registered with ``reference_path``.

    Identical CRS, transform and shape is exactly the property that makes
    cell-by-cell combination valid, so all three are compared and every
    mismatch is reported rather than only the first.
    """
    out_crs, out_transform, out_shape = describe_grid(output_path)
    ref_crs, ref_transform, ref_shape = describe_grid(reference_path)

    print(f"Grid check against {reference_path.name}")
    problems: list[str] = []
    if out_crs != ref_crs:
        problems.append(f"CRS {out_crs} != {ref_crs}")
    # Compare the six affine coefficients with a tolerance: they are floats
    # derived from the same tiling maths, so exact equality is too brittle.
    if not np.allclose(
        np.array(out_transform[:6], dtype=float),
        np.array(ref_transform[:6], dtype=float),
        rtol=0,
        atol=1e-6,
    ):
        problems.append(f"transform {tuple(out_transform[:6])} != {tuple(ref_transform[:6])}")
    if out_shape != ref_shape:
        problems.append(f"size {out_shape[0]}x{out_shape[1]} != {ref_shape[0]}x{ref_shape[1]}")

    if problems:
        for p in problems:
            print(f"  MISMATCH: {p}", file=sys.stderr)
        return False

    print(f"  OK — same CRS, transform and size ({out_shape[0]}x{out_shape[1]})")
    return True


def geojson_epsg(collection: dict) -> int | None:
    """EPSG code of a GeoJSON's ``crs`` member, or None if it has none.

    Only the OGC URN form GDAL writes (``urn:ogc:def:crs:EPSG::3857``) and the
    short ``EPSG:3857`` form are understood; anything else returns None and is
    treated as "unknown", which the caller rejects.
    """
    name = collection.get("crs", {}).get("properties", {}).get("name")
    if not isinstance(name, str):
        return None
    tail = name.rsplit(":", 1)[-1]
    return int(tail) if tail.isdigit() else None


def collect_shapes(
    features: list[dict], property_name: str
) -> tuple[list[tuple[dict, int]], dict[str, int]]:
    """Pair each usable geometry with its class value.

    Returns the (geometry, value) list ``rasterize`` wants plus a tally of what
    was left out, so a dataset full of sentinels cannot quietly produce an
    almost-empty raster.
    """
    shapes: list[tuple[dict, int]] = []
    skipped = {"missing": 0, "out_of_range": 0, "no_geometry": 0}

    for feature in features:
        geometry = feature.get("geometry")
        if not geometry or not geometry.get("coordinates"):
            skipped["no_geometry"] += 1
            continue

        value = feature.get("properties", {}).get(property_name)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            skipped["missing"] += 1
            continue
        value = int(value)
        # 255 is nodata, so a class may not claim it; negatives are the "-9"
        # style sentinels these datasets use for "not measured".
        if value < 0 or value >= NODATA:
            skipped["out_of_range"] += 1
            continue

        shapes.append((geometry, value))

    return shapes, skipped


def rule_values(node: object, property_name: str, out: set[int]) -> None:
    """Collect the literals a GeoStyler filter compares ``property_name`` to.

    Understands the boolean combinators and ``==`` only, which is every filter
    the class layers in this project use. A range or `in` filter would be
    silently ignored, so --match-rules is a check, not a proof.
    """
    if not isinstance(node, list) or not node:
        return
    op = node[0]
    if op in ("&&", "||"):
        for sub in node[1:]:
            rule_values(sub, property_name, out)
        return
    if op == "!":
        rule_values(node[1] if len(node) > 1 else None, property_name, out)
        return
    if op == "==" and len(node) == 3 and node[1] == property_name:
        if isinstance(node[2], (int, float)) and not isinstance(node[2], bool):
            out.add(int(node[2]))


def match_rules(
    layers_json: Path, layer_id: str, property_name: str, counts: dict[int, int]
) -> bool:
    """Report class values with no rule, and rules that scored no cells.

    Both directions matter. A value no rule draws is invisible on the vector
    layer but still counts toward a combination; a rule with no cells produces
    an empty result the first time someone combines that class, with nothing to
    explain why.
    """
    config = json.loads(layers_json.read_text(encoding="utf-8"))
    layers = config.get("layers", config if isinstance(config, list) else [])
    layer = next((entry for entry in layers if entry.get("id") == layer_id), None)
    if layer is None:
        print(f"error: no layer '{layer_id}' in {layers_json}", file=sys.stderr)
        return False

    rules = layer.get("geostyler", {}).get("rules", [])
    if not rules:
        print(f"error: layer '{layer_id}' has no GeoStyler rules", file=sys.stderr)
        return False

    print(f"Rule check against {layer_id} in {layers_json.name} ({len(rules)} rules)")
    covered: set[int] = set()
    problems: list[str] = []
    for rule in rules:
        values: set[int] = set()
        rule_values(rule.get("filter"), property_name, values)
        covered |= values
        if not values:
            problems.append(f"rule '{rule.get('name')}' tests no {property_name} value")
            continue
        cells = sum(counts.get(value, 0) for value in values)
        if cells == 0:
            problems.append(
                f"rule '{rule.get('name')}' ({property_name} "
                f"{', '.join(str(v) for v in sorted(values))}) matches no cells"
            )

    burned = {value for value in counts if value != NODATA}
    for value in sorted(burned - covered):
        problems.append(f"value {value} ({counts[value]:,} cells) is drawn by no rule")

    if problems:
        for p in problems:
            print(f"  PROBLEM: {p}", file=sys.stderr)
        return False

    print(f"  OK — {len(rules)} rules cover every burned value ({len(burned)} classes)")
    return True


def convert(
    input_path: Path,
    output_path: Path,
    *,
    property_name: str,
    reference_path: Path,
    all_touched: bool,
    overview_level: int,
) -> dict[int, int]:
    """Rasterise ``property_name`` onto the reference grid and write the COG."""
    print(f"Reference {reference_path}")
    with rasterio.open(reference_path) as ref:
        crs = ref.crs
        transform = ref.transform
        width, height = ref.width, ref.height
        ref_bounds = ref.bounds
    print(f"  {width}x{height}, {crs}, {transform[0]:.4f} units/px")

    print(f"Reading  {input_path}")
    collection = json.loads(input_path.read_text(encoding="utf-8"))
    features = collection.get("features", [])
    epsg = geojson_epsg(collection)
    print(f"  {len(features):,} features, CRS {epsg or 'unspecified'}")

    # No reprojection on purpose: silently misplacing every polygon is a far
    # worse outcome than refusing, and the fix (ogr2ogr) belongs upstream.
    if crs is None or epsg is None or epsg != crs.to_epsg():
        raise SystemExit(
            f"error: {input_path.name} is in EPSG:{epsg or '<unspecified>'} but the "
            f"reference grid is {crs}. Reproject first:\n"
            f"  ogr2ogr -t_srs EPSG:{crs.to_epsg()} out.geojson {input_path.name}"
        )

    shapes, skipped = collect_shapes(features, property_name)
    print(f"Burning  {property_name}: {len(shapes):,} features")
    for reason, count in skipped.items():
        if count:
            print(f"  skipped {count:,} ({reason.replace('_', ' ')}) -> nodata")
    if not shapes:
        raise SystemExit(
            f"error: no feature carries a usable {property_name} value (0..{NODATA - 1})."
        )

    data = rasterize(
        shapes,
        out_shape=(height, width),
        transform=transform,
        fill=NODATA,
        dtype="uint8",
        all_touched=all_touched,
    )

    values, cell_counts = np.unique(data, return_counts=True)
    counts = {int(v): int(c) for v, c in zip(values, cell_counts)}
    burned = sum(count for value, count in counts.items() if value != NODATA)
    if burned == 0:
        raise SystemExit(
            "error: every cell is nodata — the geometry does not overlap the "
            f"reference extent {tuple(round(v, 1) for v in ref_bounds)}."
        )

    profile = {
        "driver": "GTiff",
        "dtype": "uint8",
        "count": 1,
        "width": width,
        "height": height,
        "crs": crs,
        "transform": transform,
        "nodata": NODATA,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
    }

    print(f"Writing  {output_path}")
    # Not web_optimized: unlike the sibling script there is nothing to reproject
    # here — the array is already on the reference's WebMercatorQuad grid, and
    # re-warping an aligned raster can only move it off. 'nearest' throughout
    # because averaging class values invents classes.
    with MemoryFile() as memfile:
        with memfile.open(**profile) as mem:
            mem.write(data, 1)
        # Reopened read-only: rasterio deprecates handing a writable dataset to
        # a reader, and the write is finished by now anyway.
        with memfile.open() as src:
            cog_translate(
                src,
                output_path,
                cog_profiles.get("deflate"),
                overview_level=overview_level,
                overview_resampling="nearest",
                nodata=NODATA,
                quiet=False,
            )

    print("Validating COG…")
    is_valid, errors, warnings = cog_validate(output_path)
    for w in warnings:
        print(f"  warning: {w}")
    for e in errors:
        print(f"  error:   {e}", file=sys.stderr)

    with rasterio.open(output_path) as dst:
        size = output_path.stat().st_size
        status = "valid COG" if is_valid else "NOT a valid COG"
        print(
            f"Wrote {output_path.name} ({size:,} bytes) — "
            f"{dst.width}x{dst.height}, {dst.crs}, overviews {dst.overviews(1)}, {status}"
        )
    coverage = 100 * burned / data.size
    print(f"  {burned:,} of {data.size:,} cells burned ({coverage:.1f}% of the extent)")
    for value in sorted(counts):
        label = "nodata" if value == NODATA else f"class {value}"
        print(f"    {label:>10}: {counts[value]:,} cells")

    if not is_valid:
        raise SystemExit(1)

    return counts


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Burn one GeoJSON attribute into a single-band class COG on an "
            "existing raster's grid, so it can be combined with that raster."
        ),
    )
    parser.add_argument("input", type=Path, help="source GeoJSON")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="output COG (default: <input>.cog.tif, the layers.json URL convention)",
    )
    parser.add_argument(
        "--property",
        required=True,
        metavar="NAME",
        help=(
            "feature property to burn; its values become the cell values, so it "
            "must be the attribute the layer's GeoStyler rules test"
        ),
    )
    parser.add_argument(
        "--like",
        required=True,
        type=Path,
        metavar="PATH",
        help=(
            "reference COG whose CRS, transform and size the output adopts "
            "exactly — required, because only a shared grid makes the rasters "
            "combinable"
        ),
    )
    parser.add_argument(
        "--all-touched",
        action="store_true",
        help=(
            "burn every cell a polygon touches instead of those whose centre it "
            "contains; inflates each class across its boundary, so leave off for "
            "class data unless the polygons are thinner than a cell"
        ),
    )
    parser.add_argument(
        "--overview-level",
        type=int,
        default=DEFAULT_OVERVIEW_LEVEL,
        help=(
            f"number of overviews to build (default {DEFAULT_OVERVIEW_LEVEL} = "
            "factors 2,4,8,16). Must match the rasters this one will be combined "
            "with — the app picks an overview by index, not by factor."
        ),
    )
    parser.add_argument(
        "--match-rules",
        type=Path,
        default=None,
        metavar="LAYERS_JSON",
        help="after writing, check the burned values against a layer's GeoStyler rules",
    )
    parser.add_argument(
        "--layer-id",
        default=None,
        help="layer id to look up in --match-rules (default: the output stem)",
    )
    args = parser.parse_args(argv[1:])

    if not args.input.exists():
        print(f"error: {args.input} not found", file=sys.stderr)
        return 1
    if not args.like.exists():
        print(f"error: --like {args.like} not found", file=sys.stderr)
        return 1

    output_path = args.output or args.input.with_suffix(".cog.tif")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    counts = convert(
        args.input,
        output_path,
        property_name=args.property,
        reference_path=args.like,
        all_touched=args.all_touched,
        overview_level=args.overview_level,
    )

    if not check_grid(output_path, args.like):
        print(
            "error: output is NOT on the same grid as the reference — "
            "combining these rasters cell-by-cell would be wrong.",
            file=sys.stderr,
        )
        return 2

    if args.match_rules is not None:
        if not args.match_rules.exists():
            print(f"error: --match-rules {args.match_rules} not found", file=sys.stderr)
            return 3
        # ".cog.tif" is a double suffix, so one .stem still leaves ".cog".
        layer_id = args.layer_id or output_path.name.split(".")[0]
        if not match_rules(args.match_rules, layer_id, args.property, counts):
            return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
