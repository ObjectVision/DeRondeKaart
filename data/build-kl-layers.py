#!/usr/bin/env python3
"""Write the KL layers into objectvision/wonenenzorgopdekaart's layers.json and navigation.json.

Companion to ``build-kl-pmtiles.py``, which builds the archives these entries
point at. Both read the old WZW mirror fetched into ``data/kl/src/`` (see that
script's docstring):

* ``kl/mapgallery_1.json`` — the map gallery (``/var/mapgallery/kl/1.json``): the
  groups, subgroups, titles, descriptions, opacities and timeseries ranges;
* ``kl/kl.map`` and ``kl/mapfiles/**`` — per layer its DATA, TEMPLATE and CLASS
  blocks (with ``INCLUDE``d class schemes), turned into GeoStyler rules;
* ``symbols/symbols.sym`` + ``symbols/pictures/`` — the point symbols, copied to
  ``public/icons/kl/``.

Ported groups: Voorzieningen, Vastgoed and WMO Cliënten — without the Vastgoed
layers the user excluded (WOZ waarde (PC6) 2020, Plancapaciteit Provincie NH,
Mate van geschiktheid).

Idempotent: every layer whose id starts with ``kl_`` and every navigation group
this script owns (by label) is replaced on each run; everything else in the two
files is left as it was. The new groups go before "WoonZorgwijzer 5.0", in the
gallery's order.

    python data/build-kl-layers.py
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = HERE / "kl" / "src"
KL = SRC / "kl"
VARIANT = REPO / "configs" / "objectvision" / "wonenenzorgopdekaart"
ICON_DIR = REPO / "public" / "icons" / "kl"
ICON_URL = "/icons/kl/"
DATA_URL = "https://data.derondekaart.nl/pmtiles/wonenenzorgopdekaart/"
META_URL = "https://data.derondekaart.nl/meta/wonenenzorgopdekaart/"
# Which meta fragments exist is decided by the spreadsheet; this file is written
# by data/meta/genereer_html.py next to them and lists the layer ids per route.
META_INDEX = HERE / "meta" / "wzw5" / "wonenenzorgopdekaart" / "resultaten" / "index.json"

GROUPS = ("Voorzieningen", "Vastgoed", "WMO Cliënten")
EXCLUDE = {"WOZ waarde (PC6) 2020", "Plancapaciteit Provincie NH", "Mate van geschiktheid"}
INSERT_BEFORE = "WoonZorgwijzer 5.0"
NAV_COLOR = "#3E74A7"
GROUP_ICONS = {
    "Voorzieningen": "local_hospital",
    "Vastgoed": "home_work",
    "WMO Cliënten": "diversity_3",
    "Basis": "storefront",
    "WoonZorg": "elderly",
    "Loopafstanden dichtsbijzijnde": "directions_walk",
    "Verzorgingsgebied Sociale Wijkteams": "border_outer",
    "Aantallen per buurt": "grid_view",
}
# WMO trend: gallery service `data=` value -> id suffix.
WMO_IDS = {
    "WMO_wmo": "alle", "WMO_HbH": "hbh", "WMO_Begeleiding": "begeleiding",
    "WMO_Dagbesteding": "dagbesteding", "WMO_Vervoer": "vervoer",
    "WMO_Rolstoel": "rolstoel", "WMO_BeschermdWonen": "bwonen",
}


def load_build_module():
    spec = importlib.util.spec_from_file_location("build_kl_pmtiles", HERE / "build-kl-pmtiles.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# --- mapfile parsing ----------------------------------------------------------

BLOCKS = {"LAYER", "CLASS", "STYLE", "LABEL", "VALIDATION", "METADATA", "PROJECTION",
          "LEGEND", "WEB", "QUERYMAP", "OUTPUTFORMAT", "MAP", "SCALEBAR", "LEADER"}
TOKEN = re.compile(r"\"[^\"]*\"|'[^']*'|\S+")


def lines_of(path: Path) -> list[str]:
    """A mapfile's lines with INCLUDEs inlined (paths relative to KL)."""
    out: list[str] = []
    for raw in path.read_text(encoding="latin-1").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.upper().startswith("INCLUDE "):
            out += lines_of(KL / line.split(None, 1)[1].strip().strip("\"'"))
        else:
            out.append(line)
    return out


def parse_lines(lines: list[str]) -> list[dict]:
    """Nested blocks: {'type': 'CLASS', 'items': [(KEY, [values])], 'children': [...]}.

    Mapfiles are line-oriented: a line is a block opener, END, or ``KEY values``.
    An EXPRESSION keeps its raw text as one value.
    """
    root = {"type": "ROOT", "items": [], "children": []}
    stack = [root]
    for line in lines:
        tokens = TOKEN.findall(line)
        key = tokens[0].strip("\"'")
        upper = key.upper()
        if upper == "END":
            stack.pop()
        elif upper in BLOCKS and len(tokens) == 1:
            block = {"type": upper, "items": [], "children": []}
            stack[-1]["children"].append(block)
            stack.append(block)
        elif upper == "EXPRESSION":
            stack[-1]["items"].append((upper, [line.split(None, 1)[1]]))
        else:
            name = key if stack[-1]["type"] == "VALIDATION" else upper
            stack[-1]["items"].append((name, [t.strip("\"'") for t in tokens[1:]]))
    return root["children"]


def get(block: dict, key: str) -> list[str] | None:
    return next((v for k, v in block["items"] if k == key), None)


def mapfile_layers() -> dict[str, list[dict]]:
    """Every LAYER in kl.map, keyed by GROUP (or NAME when ungrouped)."""
    layers: dict[str, list[dict]] = {}
    for block in parse_lines(lines_of(KL / "kl.map")):
        for layer in block["children"] if block["type"] == "MAP" else [block]:
            if layer["type"] != "LAYER":
                continue
            key = (get(layer, "GROUP") or get(layer, "NAME"))[0]
            layers.setdefault(key, []).append(layer)
    return layers


def validation_defaults(layer: dict) -> dict[str, str]:
    for child in layer["children"]:
        if child["type"] == "VALIDATION":
            return {k[len("default_"):]: (v[0] if v else "") for k, v in child["items"] if k.startswith("default_")}
    return {}


# --- classes -> GeoStyler -----------------------------------------------------

CMP = re.compile(r"\[([^\]]+)\]\s*(==|=|!=|>=|<=|>|<)\s*(\"[^\"]*\"|'[^']*'|-?[\d.]+)")


def to_filter(expression: str, subst: dict[str, str]) -> list:
    """``([A] > 0 AND [A] <= 400)`` -> ``["&&", [">", "a", 0], ["<=", "a", 400]]``."""
    for key, value in subst.items():
        expression = expression.replace(f"%{key}%", value)
    parts = []
    for field, op, value in CMP.findall(expression):
        field = "class" if field.lower() == "pixel" else field.lower()
        op = "==" if op == "=" else op
        parsed: object = value.strip("\"'") if value[0] in "\"'" else (float(value) if "." in value else int(value))
        parts.append([op, field, parsed])
    if not parts:
        raise SystemExit(f"error: cannot translate EXPRESSION {expression!r}")
    if re.search(r"\bOR\b", expression, re.I):
        return ["||", *parts] if len(parts) > 1 else parts[0]
    return ["&&", *parts] if len(parts) > 1 else parts[0]


def rgb_hex(values: list[str]) -> str:
    return "#" + "".join(f"{int(v):02X}" for v in values[:3])


def main_color(cls: dict) -> tuple[str | None, str | None]:
    """The fill and outline colour that best represents a class in a legend.

    MapServer classes stack several STYLEs: an offset shadow, the fill, and
    scale-dependent outlines. The fill is the first COLOR not on an OFFSET style,
    preferring one valid at every scale.
    """
    styles = [c for c in cls["children"] if c["type"] == "STYLE"]
    fills = [s for s in styles if get(s, "COLOR") and not get(s, "OFFSET") and not get(s, "SYMBOL")]
    unscaled = [s for s in fills if not get(s, "MINSCALEDENOM") and not get(s, "MAXSCALEDENOM")]
    fill = (unscaled or fills or [None])[0]
    outlines = [s for s in styles if get(s, "OUTLINECOLOR")]
    return (rgb_hex(get(fill, "COLOR")) if fill else None,
            rgb_hex(get(outlines[0], "OUTLINECOLOR")) if outlines else None)


SYMBOLS: dict[str, str] = {}


def symbol_image(name: str) -> str:
    """Copy a symbols.sym PIXMAP to public/icons/kl/ and return its URL."""
    if not SYMBOLS:
        tokens = TOKEN.findall((SRC / "symbols" / "symbols.sym").read_text(encoding="latin-1"))
        current = None
        for a, b in zip(tokens, tokens[1:]):  # NAME "x" … IMAGE "pictures/x.png"
            if a.upper() == "NAME":
                current = b.strip('"')
            elif a.upper() == "IMAGE" and current:
                SYMBOLS[current] = b.strip('"')
    image = SRC / "symbols" / SYMBOLS[name]
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(image, ICON_DIR / image.name)
    return ICON_URL + image.name


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[16:24]
    return int.from_bytes(data[:4], "big"), int.from_bytes(data[4:], "big")


def rules_for(layer: dict, subst: dict[str, str], geometry: str) -> list[dict]:
    rules = []
    for cls in (c for c in layer["children"] if c["type"] == "CLASS"):
        expr = get(cls, "EXPRESSION")
        # MapServer legends were column-aligned with spaces ("5 -   6 per ha").
        name = " ".join(" ".join(get(cls, "NAME") or []).split())
        rule: dict = {"name": name}
        if expr:
            rule["filter"] = to_filter(expr[0], subst)
            if not name:
                rule["name"] = str(rule["filter"][2] if rule["filter"][0] != "&&" else expr[0])
        if geometry == "point":
            style = next(c for c in cls["children"] if c["type"] == "STYLE" and get(c, "SYMBOL"))
            url = symbol_image(get(style, "SYMBOL")[0])
            w, h = png_size(ICON_DIR / Path(url).name)
            rule["symbolizers"] = [{"kind": "Icon", "image": url, "width": w, "height": h, "size": h}]
        else:
            fill, outline = main_color(cls)
            if fill is None:
                # Outline-only class (the wijkteam areas): a raw line rule, since
                # a Fill symbolizer's outline is locked to 1px.
                rule.update({"type": "line", "paint": {"line-color": outline or "#DE0033", "line-width": 2}})
            else:
                rule["symbolizers"] = [{"kind": "Fill", "color": fill, "outlineWidth": 0}]
        rules.append(rule)
    names = [r["name"] for r in rules]
    if len(set(names)) != len(names):
        raise SystemExit(f"error: duplicate rule names {names}")
    return rules


# --- featureinfo from MapServer templates ---------------------------------------

def featureinfo(template: str | None) -> dict | None:
    if not template:
        return None
    text = (KL / template).read_text(encoding="latin-1")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"(\s*<(BR|br|HR|hr)\s*/?>\s*)+$", "", text.strip())
    text = re.sub(r"\[([A-Za-z0-9_]+)\]", lambda m: f"[[ {m.group(1).lower()} ]]", text)
    text = re.sub(r"\s*\n\s*", "", text)
    return {"template": f"<div>{text}</div>"}


# --- gallery -> entries ----------------------------------------------------------

def gallery() -> dict:
    return json.loads((KL / "mapgallery_1.json").read_text(encoding="utf-8-sig"))[0]


def meta_for(layer_id: str, index: dict[str, list[str]]) -> dict | None:
    routes = {route: f"{META_URL}{layer_id}_{route}.html" for route, ids in index.items() if layer_id in ids}
    return routes or None


def build(build_mod) -> tuple[list[dict], list[dict]]:
    g = gallery()
    services = {str(s["id"]): s for s in g["services"]}
    mapfiles = mapfile_layers()
    meta_index = json.loads(META_INDEX.read_text(encoding="utf-8")) if META_INDEX.is_file() else {}

    # input path (relative to SRC/kl) -> (archive, source layer)
    where: dict[str, tuple[str, str]] = {}
    for archive, spec in build_mod.ARCHIVES.items():
        for layer, bands in spec.layers.items():
            for band in bands:
                for path in band.inputs:
                    where[str(Path(path).with_suffix("")).replace("\\", "/")] = (archive, layer)

    entries: list[dict] = []

    def leaf(node: dict) -> dict:
        name = node["layername"]
        params = dict(p.split("=", 1) for p in services[str(node["service"])]["url"].split("?")[1].split("&") if "=" in p)
        theme = params.get("data")
        layers = mapfiles[name]
        first = layers[0]
        subst = validation_defaults(first)
        anim = (node.get("controls") or {}).get("animation")

        data = get(first, "DATA")[0]
        ts = None
        if anim:
            years = (str(anim["min"])[:4], str(anim["max"])[:4])
            data = data.replace("%data%", theme or "").replace("%year%", f"{years[0]}0101" if "raster" in data else years[0])
            ts = {"placeholder": "%YEAR%", "start": int(years[0]), "end": int(years[1]), "step": 1}
        data = data.replace("%data%", theme or "")
        key = str(Path(data).with_suffix("")).replace("\\", "/")
        if key not in where:
            raise SystemExit(f"error: {name}: DATA {data} is not built by build-kl-pmtiles.py")
        archive, source_layer = where[key]
        if ts:
            source_layer = source_layer.replace(str(ts["start"]), "%YEAR%")

        layer_type = get(first, "TYPE")[0].upper()
        geometry = {"POINT": "point", "POLYGON": "polygon", "RASTER": "polygon"}[layer_type]
        layer_id = f"kl_wmo_{WMO_IDS[theme]}" if theme else name

        entry: dict = {
            "id": layer_id,
            "name": node["title"].replace(", trend", ""),
        }
        if node.get("description"):
            entry["description"] = node["description"]
        entry.update({
            "source": f"{DATA_URL}{archive}.pmtiles",
            "format": "pmtiles",
            "sourceLayer": source_layer,
            "geometryType": geometry,
            "beforeid": "map-layers",
        })
        if ts:
            entry["timeseries"] = ts
        entry["style"] = {"opacity": node.get("opacity", 1.0)}
        hide = (node.get("hide_options") or {}).get("hideFeatureInfo")
        info = None if hide or layer_type == "RASTER" else featureinfo((get(first, "TEMPLATE") or [None])[0])
        if info:
            entry["featureinfo"] = info
        meta = meta_for(layer_id, meta_index)
        if meta:
            entry["meta"] = meta
        entry["geostyler"] = {"name": entry["name"], "rules": rules_for(first, subst, geometry)}
        entries.append(entry)
        return {"id": layer_id, "label": node["title"], "a": False, "b": False}

    def group(node: dict) -> dict:
        children = []
        for child in node["children"]:
            if child["title"] in EXCLUDE:
                continue
            children.append(group(child) if child.get("children") else leaf(child))
        return {"label": node["title"], "icon": GROUP_ICONS.get(node["title"], "folder"),
                "color": NAV_COLOR, "expanded": False, "children": children}

    tree = [group(t) for t in g["layertree"] if t["title"] in GROUPS]
    return entries, tree


def write_json(path: Path, data: object) -> None:
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))


def main() -> int:
    entries, tree = build(load_build_module())

    layers_path = VARIANT / "layers.json"
    layers = json.loads(layers_path.read_text(encoding="utf-8"))
    kept = [l for l in layers["layers"] if not l["id"].startswith("kl_")]
    layers["layers"] = kept + entries
    write_json(layers_path, layers)

    nav_path = VARIANT / "navigation.json"
    nav = [n for n in json.loads(nav_path.read_text(encoding="utf-8")) if n["label"] not in GROUPS]
    at = next((i for i, n in enumerate(nav) if n["label"] == INSERT_BEFORE), 0)
    nav[at:at] = tree
    write_json(nav_path, nav)

    print(f"{len(entries)} kl_* layers, {len(tree)} groups written")
    if not META_INDEX.is_file():
        print(f"note: {META_INDEX} not found — layers written without meta; rerun after genereer_html.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
