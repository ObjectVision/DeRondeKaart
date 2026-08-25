#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Build the ``2025_2026`` config variant: both years in one, leaf by leaf.

The ``startanalyse2026`` project ships a ``2025`` and a ``2026`` variant, one
active at a time. Comparing a metric across the two years therefore could not be
done at all: switching variant swaps the whole catalogue, so the other year
leaves the screen. This generates a third variant holding **both** years, whose
navigation tree pairs each metric with itself -- 2025 on the left map, 2026 on
the right -- so one click opens the comparison.

Two files are written, into ``configs/startanalyse2026/2025_2026/``:

``layers.json``
    Every 2025 layer verbatim, plus each year-scoped 2026 layer with ``_2026``
    appended to its id. Nothing else about a layer changes: the two years differ
    only in ``source``, ``meta`` and a trailing space in ``name``, and rewriting
    any of those here would make this file disagree with the variant it came
    from.

``navigation.json``
    The 2026 tree, structurally untouched, with every year-scoped leaf gaining
    ``left``/``right`` -- the paired-leaf fields ``leafPair()`` reads in
    ``src/layers/navigation.ts``. Leaves naming a year-neutral layer stay
    ordinary single-layer leaves.

Re-runnable by design: it regenerates from the 2025 and 2026 sources rather than
patching its own output, so refreshing either year is one command.

Usage::

    python data/build-merged-variant.py            # write the variant
    python data/build-merged-variant.py --check    # verify without writing
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent / "configs" / "startanalyse2026"
LEFT_YEAR = "2025"
RIGHT_YEAR = "2026"
MERGED = f"{LEFT_YEAR}_{RIGHT_YEAR}"

# Only layers served from this prefix belong to a year. Everything else --
# `pand`, `TEO`, `WKO`, `geothermie`, `aanbod`, the study area -- is shared
# between the variants and must appear once, not twice.
TILE_ROOT = "https://data.startanalyse2026.nl/pmtiles/"

# Suffix that makes a 2026 id unique alongside its 2025 twin. Underscore rather
# than a separator the layer system already claims: `__b`/`__c` mark composite
# children and `filter__` marks session-built combination layers.
SUFFIX = f"_{RIGHT_YEAR}"

# Ids map.json names directly. They must resolve in the merged catalogue under
# the exact spelling map.json uses, so the check below fails loudly if a future
# rename breaks the reference rather than leaving the map unclickable at runtime.
MAP_JSON_REFS = ("buurt_klik", "studiegebied_nederland")


def year_prefix(year: str) -> str:
    return f"{TILE_ROOT}{year}/"


def load_layers(year: str) -> list[dict]:
    """The layer list of one variant. The file's top level is an object."""
    data = json.loads((PROJECT / year / "layers.json").read_text(encoding="utf-8"))
    return data["layers"] if isinstance(data, dict) else data


def load_navigation(year: str) -> list:
    return json.loads((PROJECT / year / "navigation.json").read_text(encoding="utf-8"))


def is_year_scoped(layer: dict, year: str) -> bool:
    return str(layer.get("source") or "").startswith(year_prefix(year))


def pairable_ids(left: list[dict], right: list[dict]) -> set[str]:
    """Ids present as a year-scoped layer in BOTH variants.

    An id year-scoped on one side but not the other is not pairable and is
    reported rather than silently half-merged -- a leaf pointing at a `_2026`
    layer that was never emitted would fail with only a console warning.
    """
    left_year = {str(x["id"]) for x in left if is_year_scoped(x, LEFT_YEAR)}
    right_year = {str(x["id"]) for x in right if is_year_scoped(x, RIGHT_YEAR)}

    only_left = left_year - right_year
    only_right = right_year - left_year
    if only_left or only_right:
        raise SystemExit(
            f"year-scoped ids do not match across variants: "
            f"only in {LEFT_YEAR}={sorted(only_left)}, only in {RIGHT_YEAR}={sorted(only_right)}"
        )
    return left_year & right_year


def build_layers(left: list[dict], right: list[dict], pairable: set[str]) -> dict:
    """Both catalogues in one file, the 2026 half re-identified."""
    merged = [copy.deepcopy(x) for x in left]

    by_id = {str(x["id"]): x for x in right}
    for layer_id in sorted(pairable):
        clone = copy.deepcopy(by_id[layer_id])
        clone["id"] = layer_id + SUFFIX
        merged.append(clone)

    return {"layers": merged}


def build_navigation(tree: list, pairable: set[str]) -> list:
    """The 2026 tree with its year-scoped leaves turned into pairs."""

    def convert(items: list) -> list:
        out = []
        for item in items:
            if "children" in item:
                branch = {k: v for k, v in item.items() if k != "children"}
                branch["children"] = convert(item["children"])
                out.append(branch)
                continue

            leaf = dict(item)
            # `id` is left alone: it is the leaf's own identity, which selection
            # and branch-expansion state key on, not a layer reference here.
            if str(leaf.get("id", "")) in pairable:
                leaf["left"] = str(leaf["id"])
                leaf["right"] = str(leaf["id"]) + SUFFIX
            out.append(leaf)
        return out

    return convert(copy.deepcopy(tree))


def strip_pairs(items: list) -> list:
    """The tree as it would look without the paired fields, for comparison."""
    out = []
    for item in items:
        if "children" in item:
            branch = {k: v for k, v in item.items() if k != "children"}
            branch["children"] = strip_pairs(item["children"])
            out.append(branch)
        else:
            out.append({k: v for k, v in item.items() if k not in ("left", "right")})
    return out


def count_leaves(items: list) -> tuple[int, int]:
    """(paired, plain) leaf counts, at any depth."""
    paired = plain = 0
    for item in items:
        if "children" in item:
            a, b = count_leaves(item["children"])
            paired += a
            plain += b
        elif item.get("left") and item.get("right"):
            paired += 1
        else:
            plain += 1
    return paired, plain


def validate(layers: dict, navigation: list, source_tree: list) -> None:
    """Catch the mistakes that produce a variant which loads but misbehaves."""
    ids = [str(x["id"]) for x in layers["layers"]]

    # A duplicate id silently loses one of the two layers: `addLayer` dedupes by
    # id, so the second would never reach the map.
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise SystemExit(f"duplicate layer ids in the merged catalogue: {duplicates}")

    # map.json is shared across variants, so its references must resolve here
    # under the same spelling -- an unresolvable pickLayer leaves the whole map
    # unclickable with nothing but a console warning.
    missing = [ref for ref in MAP_JSON_REFS if ref not in set(ids)]
    if missing:
        raise SystemExit(f"map.json references absent from the merged catalogue: {missing}")

    # Every paired leaf must name two layers that exist, or the pair half-applies.
    known = set(ids)
    def check(items: list) -> None:
        for item in items:
            if "children" in item:
                check(item["children"])
                continue
            for side in ("left", "right"):
                ref = item.get(side)
                if ref and ref not in known:
                    raise SystemExit(
                        f"leaf {item.get('id')!r} names {side}={ref!r}, which is not a layer"
                    )
    check(navigation)

    # The tree must be the 2026 tree plus the pair fields and nothing else: a
    # dropped branch or reordered leaf would be invisible in the counts alone.
    if strip_pairs(navigation) != source_tree:
        raise SystemExit(f"generated tree differs from the {RIGHT_YEAR} tree beyond left/right")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate and report without writing, and fail if the output is stale",
    )
    args = parser.parse_args()

    left = load_layers(LEFT_YEAR)
    right = load_layers(RIGHT_YEAR)
    source_tree = load_navigation(RIGHT_YEAR)

    pairable = pairable_ids(left, right)
    layers = build_layers(left, right, pairable)
    navigation = build_navigation(source_tree, pairable)
    validate(layers, navigation, source_tree)

    paired, plain = count_leaves(navigation)
    print(
        f"{len(left)} ({LEFT_YEAR}) + {len(pairable)} ({RIGHT_YEAR}, suffixed) "
        f"= {len(layers['layers'])} layers"
    )
    print(f"{paired} paired leaves, {plain} single-layer leaves")

    out_dir = PROJECT / MERGED
    files = {"layers.json": layers, "navigation.json": navigation}

    if args.check:
        stale = []
        for name, value in files.items():
            path = out_dir / name
            if not path.exists():
                stale.append(f"{name} (missing)")
            elif json.loads(path.read_text(encoding="utf-8")) != value:
                stale.append(name)
        if stale:
            raise SystemExit(f"out of date, re-run without --check: {', '.join(stale)}")
        print(f"{out_dir} is up to date")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, value in files.items():
        text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        (out_dir / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {out_dir / name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
