#!/usr/bin/env python3
"""Seed ``data/meta/wzw5/wonenenzorgopdekaart/metadata.xlsx`` from the old WZW metainfo pages.

ONE-OFF. The spreadsheet is the source of truth once it exists (see
``data/meta/README.md``), so this refuses to overwrite it without ``--force``,
which would throw away every edit made since.

Each KL layer that ``build-kl-layers.py`` writes has a ``metadataUrl`` in the old
map gallery (``data/kl/src/kl/mapgallery_1.json``) pointing at a page under
``https://wzwkaart.nl/files/kl/meta/``. Those pages share one shape —
"Omschrijving", then a list of sources each with Bronhouder / Datum /
Omschrijving / Link — which maps straight onto the spreadsheet:

* Omschrijving -> ``kaartlaag``: "Wat ziet u?"
* each source  -> ``bronnen`` (deduplicated by name) and ``kaartlagen_bronnen``
  (layer, source, date).

The pages are fetched once and cached in ``data/kl/src/meta/``. They declare
utf-8 but are cp1252, so they are decoded as such.

The workbook is a copy of ``woonzorglimburg/metadata.xlsx`` with its rows cleared,
so the sheet layout ``genereer_html.py`` reads stays identical. Only the
``voorziening_locaties`` kaartlaagtype is kept — it is generic, the others are
Limburg-specific — and assigned to the point layers.

    python data/build-kl-metadata.py [--force]
"""
from __future__ import annotations

import html
import importlib.util
import json
import re
import sys
import urllib.request
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "meta" / "woonzorglimburg" / "metadata.xlsx"
PROJECT = HERE / "meta" / "wzw5" / "wonenenzorgopdekaart"
CACHE = HERE / "kl" / "src" / "meta"
PROJECT_JSON = {
    "public_base": "https://data.derondekaart.nl/meta/wonenenzorgopdekaart/",
    "upload": "ov-data:/var/www/objectvision_data/meta/wonenenzorgopdekaart/",
}
KEEP_TYPES = {"voorziening_locaties"}
FIRST_DATA_ROW = 5  # rows 1-4: title, explanation, blank, header


def load_layers_module():
    spec = importlib.util.spec_from_file_location("build_kl_layers", HERE / "build-kl-layers.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fetch(url: str) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.is_file():
        request = urllib.request.Request(url, headers={"User-Agent": "metadata-import"})
        with urllib.request.urlopen(request, timeout=30) as response:
            path.write_bytes(response.read())
    return path.read_bytes().decode("cp1252")


def clean(fragment: str) -> str:
    """Collapse whitespace and &nbsp; padding; keep inline HTML such as <br> and <a>."""
    text = html.unescape(fragment.replace("&nbsp;", " "))
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"(?i)<br\s*/?>", "<br>", text).strip()


def parse_page(text: str) -> tuple[str, list[dict]]:
    match = re.search(r"(?is)Omschrijving:</B><BR>(.*?)<B>Bronnen:</B>", text)
    omschrijving = clean(match.group(1)) if match else ""
    omschrijving = re.sub(r"(<br>\s*)+$", "", omschrijving)
    sources = []
    # Each source: a striped table holding its name, then a table of fields.
    for name, body in re.findall(
        r'(?is)<table[^>]*table-striped[^>]*>\s*<tr><td>(.*?)</td>.*?</table>\s*<table>(.*?)</table>', text
    ):
        fields = {k.lower(): v for k, v in re.findall(r"(?is)<B>([^<:]+):</B>\s*(.*?)</td>", body)}
        link = re.search(r'(?is)href\s*=\s*"([^"]+)"', fields.get("link", ""))
        sources.append({
            "naam": clean(name),
            "bronhouder": clean(fields.get("bronhouder", "")),
            "datum": clean(fields.get("datum", "")),
            "omschrijving": clean(fields.get("omschrijving", "")),
            "url": link.group(1).strip() if link else "",
        })
    return omschrijving, sources


def gallery_leaves(layers_mod) -> list[tuple[str, dict, list[str]]]:
    """(layer id, gallery node, group path) in navigation order."""
    _, tree = layers_mod.build(layers_mod.load_build_module())
    g = layers_mod.gallery()
    out = []

    def walk(node: dict, nav: dict, path: list[str]) -> None:
        kids = [c for c in node["children"] if c["title"] not in layers_mod.EXCLUDE]
        for child, nav_child in zip(kids, nav["children"], strict=True):
            if child.get("children"):
                walk(child, nav_child, path + [child["title"]])
            else:
                out.append((nav_child["id"], child, path))

    for top in g["layertree"]:
        if top["title"] in layers_mod.GROUPS:
            walk(top, next(n for n in tree if n["label"] == top["title"]), [top["title"]])
    return out


def clear(ws) -> None:
    if ws.max_row >= FIRST_DATA_ROW:
        ws.delete_rows(FIRST_DATA_ROW, ws.max_row - FIRST_DATA_ROW + 1)


def main(argv: list[str]) -> int:
    target = PROJECT / "metadata.xlsx"
    if target.exists() and "--force" not in argv:
        raise SystemExit(f"error: {target} exists — it is the source of truth now; pass --force to overwrite")

    layers_mod = load_layers_module()
    wb = openpyxl.load_workbook(TEMPLATE)
    kaartlaag, typen, bronnen, koppeling = (
        wb[name] for name in ("kaartlaag", "kaartlaagtypen", "bronnen", "kaartlagen_bronnen")
    )
    kept_types = [row for row in typen.iter_rows(min_row=FIRST_DATA_ROW, values_only=True)
                  if row[0] in KEEP_TYPES]
    for ws in (kaartlaag, typen, bronnen, koppeling):
        clear(ws)
    for row in kept_types:
        typen.append(list(row[:2]))

    seen_sources: dict[str, dict] = {}
    for layer_id, node, path in gallery_leaves(layers_mod):
        url = node.get("metadataUrl")
        omschrijving, sources = parse_page(fetch(url)) if url else ("", [])
        if not omschrijving:
            omschrijving = node.get("description", "")
        kaartlaagtype = "voorziening_locaties" if layer_id.endswith(("_lokatie", "_2025")) else None
        kaartlaag.append([
            layer_id,
            node["title"].replace(", trend", ""),
            "; ".join(path),
            omschrijving,
            kaartlaagtype,
            None,
        ])
        for source in sources:
            seen_sources.setdefault(source["naam"], source)
            koppeling.append([layer_id, source["naam"], source["datum"]])

    for source in seen_sources.values():
        bronnen.append([source["naam"], source["bronhouder"], source["omschrijving"], source["url"] or None, None])

    PROJECT.mkdir(parents=True, exist_ok=True)
    wb.save(target)
    (PROJECT / "project.json").write_text(json.dumps(PROJECT_JSON, indent=2) + "\n", encoding="utf-8")
    print(f"{target}: {kaartlaag.max_row - FIRST_DATA_ROW + 1} kaartlagen, "
          f"{len(seen_sources)} bronnen, {koppeling.max_row - FIRST_DATA_ROW + 1} koppelingen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
