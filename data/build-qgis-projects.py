#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Build a QGIS project (``.qgs``) for each dataset archive under ``downloads/``.

Each archive published at ``data.startanalyse2026.nl/downloads/<year>/`` holds a
GeoPackage and a CSV but none of the styling the web app applies. This turns
``configs/startanalyse2026/<year>/layers.json`` into a QGIS project per archive,
so unzipping and opening the ``.qgs`` reproduces the app's layers, colours and
grouping against the GeoPackage sitting beside it.

Layers point at the **local** GeoPackage by relative path (``./strat1.gpkg``),
not at the remote PMTiles the styles were written for. That is the whole point
of shipping the project inside the archive: it works offline. Two consequences
are handled here rather than left to QGIS:

* The PMTiles build lowercases field names, so ``layers.json`` filters say
  ``v01_strategievariant`` while the GeoPackage column is
  ``V01_Strategievariant``. Every field is resolved case-insensitively against
  the real schema read from the ``.gpkg``.
* Layers whose data is not in the archive (the basemap, the study area, the
  ``lt``/``mt``/bronnen sources) are dropped -- there is nothing for them to
  point at.

Groups mirror ``navigation.json``, pruned to the layers this archive can serve,
with empty groups removed.

Usage:
    # Both years, archives already unpacked one folder per archive:
    python3 build-qgis-projects.py --gpkg-dir /tmp/downloads --out-dir /tmp/qgs

    # One year, one archive:
    python3 build-qgis-projects.py --year 2026 --only strat1 \
        --gpkg-dir /tmp/downloads --out-dir /tmp/qgs

``--gpkg-dir`` is expected to hold ``<year>/<archive>/*.gpkg``; ``--out-dir``
receives ``<year>/<archive>.qgs``.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import sqlite3
import sys
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Configuration facts
# ---------------------------------------------------------------------------

YEARS = ("2025", "2026")

# Which archive each pmtiles source belongs to. LNGA09-11 ship in the archive
# but no layer config references them, so they get no QGIS layers.
ARCHIVE_OF_SOURCE = {
    "stratLN.pmtiles": "stratLN",
    "strat1.pmtiles": "strat1",
    "strat2.pmtiles": "strat2",
    "strat3.pmtiles": "strat3",
    "strat4.pmtiles": "strat4",
    # The 2023 reference. Its pmtiles source keeps the older `ref19` spelling
    # (the live app fetches it by that name); the download archive is ref23.
    "ref19.pmtiles": "ref23",
    "ref30.pmtiles": "ref30",
    **{f"LNGA{i:02d}.pmtiles": "LNGA" for i in range(1, 12)},
}

# Group label per archive, matching the navigation tree the app shows.
ARCHIVE_LABEL = {
    "stratLN": "Laagste nationale kosten (LN)",
    "LNGA": "Gevoeligheidsanalyses (LNGA)",
    "strat1": "Strategie 1: eWP",
    "strat2": "Strategie 2: MT-warmtenet",
    "strat3": "Strategie 3: Combi LT-WN & eWP",
    "strat4": "Strategie 4: hWP met klimaatneutraal gas",
    "ref23": "Referentie 2023",
    "ref30": "Referentie 2030",
}

# Amersfoort / RD New -- the CRS every GeoPackage declares.
#
# The WKT is what makes this portable, and it is not optional. QGIS 3.28+
# resolves a CRS from <wkt> first; with that element empty it falls back to
# <srsid>, which is a row id in the *local* srs.db and differs between installs
# and QGIS versions -- so the project would silently adopt whatever CRS that row
# happens to name on the reader's machine.
#
# WKT2:2019 for EPSG:28992, exactly as PROJ emits it
# (`pyproj.CRS.from_epsg(28992).to_wkt("WKT2_2019")`).
RD_NEW_WKT = (
    'PROJCRS["Amersfoort / RD New",BASEGEOGCRS["Amersfoort",DATUM["Amersfoort",'
    'ELLIPSOID["Bessel 1841",6377397.155,299.1528128,LENGTHUNIT["metre",1]]],'
    'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",'
    '4289]],CONVERSION["RD New",METHOD["Oblique Stereographic",ID["EPSG",9809]],'
    'PARAMETER["Latitude of natural origin",52.1561605555556,ANGLEUNIT["degree",'
    '0.0174532925199433],ID["EPSG",8801]],'
    'PARAMETER["Longitude of natural origin",5.38763888888889,ANGLEUNIT["degree",'
    '0.0174532925199433],ID["EPSG",8802]],'
    'PARAMETER["Scale factor at natural origin",0.9999079,SCALEUNIT["unity",1],'
    'ID["EPSG",8805]],PARAMETER["False easting",155000,LENGTHUNIT["metre",1],'
    'ID["EPSG",8806]],PARAMETER["False northing",463000,LENGTHUNIT["metre",1],'
    'ID["EPSG",8807]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],'
    'LENGTHUNIT["metre",1]],AXIS["northing (Y)",north,ORDER[2],'
    'LENGTHUNIT["metre",1]],USAGE[SCOPE["Engineering survey,'
    ' topographic mapping."],AREA["Netherlands - onshore, including Waddenzee,'
    ' Dutch Wadden Islands and 12-mile offshore coastal zone."],BBOX[50.75,3.2,'
    '53.7,7.22]],ID["EPSG",28992]]'
)

RD_NEW = {
    "wkt": RD_NEW_WKT,
    # No +towgs84: PROJ's own definition of 28992 carries none, and adding the
    # legacy 3-parameter shift would override the RDNAPTRANS transformation
    # QGIS picks by default, moving coordinates by a few decimetres.
    "proj4": (
        "+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 "
        "+k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel "
        "+units=m +no_defs"
    ),
    # A local srs.db row id, kept only because QGIS writes one. `wkt` and
    # `authid` above are what actually resolve the CRS.
    "srsid": "2517",
    "srid": "28992",
    "authid": "EPSG:28992",
    "description": "Amersfoort / RD New",
    "projectionacronym": "sterea",
    "ellipsoidacronym": "EPSG:7004",
}

QGIS_VERSION = "3.28.0-Firenze"

# Navigation group skipped entirely: it re-lists layers that already appear
# under their own group, so including it would duplicate them in the tree.
EXCLUDED_GROUP = "kernkaarten"

# Hatch geometry, mirroring src/layers/hatch-pattern.ts. `hatch: true` resolves
# to HATCH_DEFAULTS there -- red on white, NOT the symbolizer's own colour,
# which the opaque pattern hides completely.
HATCH_STRIPE = "#E02B27"
HATCH_BACKGROUND = "#ffffff"
HATCH_ANGLE = 45
HATCH_LINE_WIDTH = 1
HATCH_DISTANCE = 8 / (2**0.5)

# `outlineColor` is the literal string "black" everywhere in these configs.
NAMED_COLORS = {
    "black": "#000000",
    "white": "#ffffff",
    "red": "#ff0000",
    "grey": "#808080",
    "gray": "#808080",
    "transparent": "#00000000",
}

DEFAULT_OUTLINE = "#000000"

# Deterministic ids, so regenerating a project gives a stable diff.
UUID_NS = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")


def stable_uuid(*parts: object) -> str:
    return "{%s}" % uuid.uuid5(UUID_NS, "/".join(str(p) for p in parts))


# ---------------------------------------------------------------------------
# Colour handling
# ---------------------------------------------------------------------------


def qgis_color(value: str | None, opacity: float = 1.0, *, fallback: str = DEFAULT_OUTLINE) -> str:
    """A geostyler colour as QGIS's "R,G,B,A" decimal string.

    QGIS's Option form takes decimal components, not hex, and silently ignores a
    value it cannot parse -- which renders as black rather than as an error.
    """
    raw = (value or fallback).strip()
    raw = NAMED_COLORS.get(raw.lower(), raw)
    raw = raw.lstrip("#")
    if len(raw) == 3:
        raw = "".join(c * 2 for c in raw)
    if len(raw) not in (6, 8):
        raw = fallback.lstrip("#")
    r, g, b = (int(raw[i : i + 2], 16) for i in (0, 2, 4))
    a = int(raw[6:8], 16) / 255 if len(raw) == 8 else 1.0
    return f"{r},{g},{b},{round(a * opacity * 255)}"


# ---------------------------------------------------------------------------
# Filter translation
# ---------------------------------------------------------------------------


class MissingField(Exception):
    """A geostyler filter names a field the GeoPackage has no column for."""


def sql_literal(value: object) -> str:
    # bool before int: isinstance(True, int) is True in Python, so an unchecked
    # int branch would turn `== true` into `= 1`.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


COMPARISONS = {"==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">="}


def column_ref(column: str, value: object) -> str:
    """A column as one side of a comparison, unquoted when comparing strings.

    Three TEXT columns arrive from the upstream export wrapped in literal
    apostrophes -- `V01_Strategievariant` holds the five characters ``'s1a'``,
    not ``s1a`` -- so a plain equality against `'s1a'` matches nothing. That is
    71% of the rules, which is why almost no class painted.

    Stripping the quotes in the expression keeps the published GeoPackages and
    CSVs untouched. It is applied to every string comparison rather than to a
    list of known columns: it is a no-op on unquoted values, so it stays correct
    if the export changes which columns it quotes.

    `replace` rather than `trim`: QGIS's `trim()` takes one argument and strips
    whitespace only. The two-argument `trim(x, chars)` is SQLite-only and would
    be a syntax error in the expression engine that evaluates rule filters.

    Numbers and booleans are never wrapped -- doing so would coerce them to text
    and break the comparisons that already work.
    """
    quoted = '"%s"' % column
    if isinstance(value, str):
        # '''' is a single-quoted string holding one escaped apostrophe.
        return "replace(%s, '''', '')" % quoted
    return quoted


def to_expression(node: object, resolve) -> str:
    """Translate one geostyler filter into a QGIS expression.

    The grammar in these configs is closed: &&, ||, ! (always wrapping `has`),
    has, ==, <, >, >=, with comparisons always `field op literal`.
    """
    if not isinstance(node, list) or not node:
        raise MissingField(f"unsupported filter node: {node!r}")

    op = node[0]

    if op in ("&&", "||"):
        joiner = " AND " if op == "&&" else " OR "
        return "(" + joiner.join(to_expression(a, resolve) for a in node[1:]) + ")"

    if op == "!":
        inner = node[1]
        # `!has` is the common shape; IS NULL reads better than negating.
        if isinstance(inner, list) and inner and inner[0] == "has":
            return '"%s" IS NULL' % resolve(inner[1])
        return "NOT " + to_expression(inner, resolve)

    if op == "has":
        return '"%s" IS NOT NULL' % resolve(node[1])

    if op in COMPARISONS:
        return "(%s %s %s)" % (
            column_ref(resolve(node[1]), node[2]),
            COMPARISONS[op],
            sql_literal(node[2]),
        )

    raise MissingField(f"unsupported filter operator: {op!r}")


# ---------------------------------------------------------------------------
# GeoPackage introspection
# ---------------------------------------------------------------------------

WKB_TO_QGIS = {
    "POLYGON": ("Polygon", "Polygon"),
    "MULTIPOLYGON": ("Polygon", "MultiPolygon"),
    "POINT": ("Point", "Point"),
    "MULTIPOINT": ("Point", "MultiPoint"),
    "LINESTRING": ("Line", "LineString"),
    "MULTILINESTRING": ("Line", "MultiLineString"),
}


class GeoPackage:
    """The one feature table in a .gpkg, and the column names as stored."""

    def __init__(self, path: Path) -> None:
        self.path = path
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT table_name, geometry_type_name, srs_id "
                "FROM gpkg_geometry_columns LIMIT 1"
            ).fetchone()
            if row is None:
                raise ValueError(f"{path.name}: no feature table")
            self.table, geom_type, self.srs_id = row
            columns = [r[1] for r in con.execute(f'PRAGMA table_info("{self.table}")')]
        finally:
            con.close()
        self.columns = columns
        self.lookup = {c.lower(): c for c in columns}
        # A wkbType narrower than the table's own drops every feature, with the
        # project still opening cleanly -- so it is read, never assumed.
        self.geometry, self.wkb_type = WKB_TO_QGIS.get(
            (geom_type or "").upper(), ("Polygon", "MultiPolygon")
        )

    def resolve(self, field: str) -> str:
        column = self.lookup.get(field.lower())
        if column is None:
            raise MissingField(field)
        return column

    @property
    def datasource(self) -> str:
        return f"./{self.path.name}|layername={self.table}"


# ---------------------------------------------------------------------------
# Symbol XML
# ---------------------------------------------------------------------------


def _option_map(parent: ET.Element, values: dict[str, str]) -> None:
    opt = ET.SubElement(parent, "Option", {"type": "Map"})
    for key in sorted(values):
        ET.SubElement(
            opt, "Option", {"name": key, "type": "QString", "value": values[key]}
        )


def _data_defined(parent: ET.Element) -> None:
    ddp = ET.SubElement(parent, "data_defined_properties")
    opt = ET.SubElement(ddp, "Option", {"type": "Map"})
    ET.SubElement(opt, "Option", {"name": "name", "type": "QString", "value": ""})
    ET.SubElement(opt, "Option", {"name": "properties"})
    ET.SubElement(
        opt, "Option", {"name": "type", "type": "QString", "value": "collection"}
    )


def _simple_fill(parent: ET.Element, uid: str, fill: str, outline: str, width: float) -> None:
    layer = ET.SubElement(
        parent,
        "layer",
        {"class": "SimpleFill", "locked": "0", "pass": "0", "enabled": "1", "id": uid},
    )
    _option_map(
        layer,
        {
            "border_width_map_unit_scale": "3x:0,0,0,0,0,0",
            "color": fill,
            "joinstyle": "bevel",
            "offset": "0,0",
            "offset_map_unit_scale": "3x:0,0,0,0,0,0",
            "offset_unit": "MM",
            "outline_color": outline,
            "outline_style": "solid",
            "outline_width": str(width),
            # Pixel, not the QGIS default MM: outlineWidth is a MapLibre CSS px
            # and 0.3 MM draws a visibly heavier line.
            "outline_width_unit": "Pixel",
            "style": "solid",
        },
    )
    _data_defined(layer)


def _line_pattern_fill(parent: ET.Element, symbol_name: str, uid: str) -> None:
    stripe = qgis_color(HATCH_STRIPE)
    layer = ET.SubElement(
        parent,
        "layer",
        {
            "class": "LinePatternFill",
            "locked": "0",
            "pass": "0",
            "enabled": "1",
            "id": uid + "-h",
        },
    )
    _option_map(
        layer,
        {
            "angle": str(HATCH_ANGLE),
            "clip_mode": "during_render",
            "color": stripe,
            "coordinate_reference": "feature",
            "distance": f"{HATCH_DISTANCE:.14f}",
            "distance_map_unit_scale": "3x:0,0,0,0,0,0",
            "distance_unit": "Pixel",
            "line_width": str(HATCH_LINE_WIDTH),
            "line_width_map_unit_scale": "3x:0,0,0,0,0,0",
            "line_width_unit": "Pixel",
            "offset": "0",
            "offset_map_unit_scale": "3x:0,0,0,0,0,0",
            "offset_unit": "Pixel",
            "outline_width_unit": "MM",
        },
    )
    _data_defined(layer)
    # QGIS 3.28 reads the stripe from this nested symbol; the Options above are
    # legacy fallbacks. Without it the hatch draws thin and black.
    inner = ET.SubElement(
        layer,
        "symbol",
        {
            "name": f"@{symbol_name}@1",
            "type": "line",
            "alpha": "1",
            "clip_to_extent": "1",
            "frame_rate": "10",
            "force_rhr": "0",
            "is_animated": "0",
        },
    )
    _data_defined(inner)
    line = ET.SubElement(
        inner,
        "layer",
        {"class": "SimpleLine", "locked": "0", "pass": "0", "enabled": "1", "id": uid + "-s"},
    )
    _option_map(
        line,
        {
            "align_dash_pattern": "0",
            "capstyle": "flat",
            "customdash": "5;2",
            "customdash_map_unit_scale": "3x:0,0,0,0,0,0",
            "customdash_unit": "MM",
            "draw_inside_polygon": "0",
            "joinstyle": "bevel",
            "line_color": stripe,
            "line_style": "solid",
            "line_width": str(HATCH_LINE_WIDTH),
            "line_width_unit": "Pixel",
            "offset": "0",
            "offset_map_unit_scale": "3x:0,0,0,0,0,0",
            "offset_unit": "MM",
            "ring_filter": "0",
            "trim_distance_end": "0",
            "trim_distance_start": "0",
            "tweak_dash_pattern_on_corners": "0",
            "use_custom_dash": "0",
            "width_map_unit_scale": "3x:0,0,0,0,0,0",
        },
    )
    _data_defined(line)


def build_symbol(parent: ET.Element, name: str, symbolizer: dict, uid: str) -> None:
    """One geostyler Fill symbolizer as a QGIS fill symbol."""
    opacity = symbolizer.get("opacity", 1)
    outline = qgis_color(
        symbolizer.get("outlineColor"), symbolizer.get("outlineOpacity", 1)
    )
    width = symbolizer.get("outlineWidth", 0.3)

    symbol = ET.SubElement(
        parent,
        "symbol",
        {
            "name": name,
            "type": "fill",
            # Symbol-wide alpha, matching MapLibre's fill-opacity. Folding it
            # into the colour instead would square it against outlineOpacity.
            "alpha": str(opacity),
            "clip_to_extent": "1",
            "frame_rate": "10",
            "force_rhr": "0",
            "is_animated": "0",
        },
    )
    _data_defined(symbol)

    if symbolizer.get("hatch"):
        # Background first: in QGIS the first <layer> is drawn underneath.
        _simple_fill(symbol, uid, qgis_color(HATCH_BACKGROUND), outline, width)
        _line_pattern_fill(symbol, name, uid)
    else:
        _simple_fill(symbol, uid, qgis_color(symbolizer.get("color"), fallback="#cccccc"), outline, width)


# ---------------------------------------------------------------------------
# Layer XML
# ---------------------------------------------------------------------------


def _spatialrefsys(parent: ET.Element) -> None:
    srs = ET.SubElement(parent, "spatialrefsys", {"nativeFormat": "Wkt"})
    for key in ("wkt", "proj4", "srsid", "srid", "authid", "description",
                "projectionacronym", "ellipsoidacronym"):
        ET.SubElement(srs, key).text = RD_NEW[key]
    ET.SubElement(srs, "geographicflag").text = "false"


def build_renderer(parent: ET.Element, layer: dict, gpkg: GeoPackage, layer_id: str) -> int:
    """A RuleRenderer for one layer. Returns the rule count."""
    rules_src = (layer.get("geostyler") or {}).get("rules") or []

    renderer = ET.SubElement(
        parent,
        "renderer-v2",
        {
            "type": "RuleRenderer",
            "symbollevels": "0",
            "forceraster": "0",
            "enableorderby": "0",
            "referencescale": "-1",
        },
    )
    rules_el = ET.SubElement(renderer, "rules", {"key": stable_uuid(layer_id)})
    symbols_el = ET.SubElement(renderer, "symbols")

    # Reversed: geostyler takes the FIRST matching rule, while QGIS paints every
    # match in document order so the last drawn wins. Reversing makes the
    # topmost drawn rule the one the app would have picked.
    ordered = list(enumerate(rules_src))[::-1]

    index = 0
    for original_index, rule in ordered:
        expression = to_expression(rule["filter"], gpkg.resolve)
        for symbolizer in rule.get("symbolizers") or []:
            name = str(index)
            ET.SubElement(
                rules_el,
                "rule",
                {
                    "key": stable_uuid(layer_id, original_index, index),
                    "symbol": name,
                    "label": (rule.get("name") or "").strip(),
                    "filter": expression,
                },
            )
            build_symbol(symbols_el, name, symbolizer, stable_uuid(layer_id, index))
            index += 1

    return index


def build_maplayer(parent: ET.Element, layer: dict, gpkg: GeoPackage, layer_id: str) -> None:
    maplayer = ET.SubElement(
        parent,
        "maplayer",
        {
            "type": "vector",
            "geometry": gpkg.geometry,
            "wkbType": gpkg.wkb_type,
            "hasScaleBasedVisibilityFlag": "0",
            "minScale": "1e+08",
            "maxScale": "0",
            "styleCategories": "AllStyleCategories",
            "refreshOnNotifyEnabled": "0",
            "autoRefreshEnabled": "0",
        },
    )
    ET.SubElement(maplayer, "id").text = layer_id
    ET.SubElement(maplayer, "datasource").text = gpkg.datasource
    ET.SubElement(maplayer, "layername").text = (layer.get("name") or layer_id).strip()
    ET.SubElement(maplayer, "provider", {"encoding": "UTF-8"}).text = "ogr"
    srs = ET.SubElement(maplayer, "srs")
    _spatialrefsys(srs)
    build_renderer(maplayer, layer, gpkg, layer_id)
    ET.SubElement(maplayer, "blendMode").text = "0"
    ET.SubElement(maplayer, "featureBlendMode").text = "0"
    ET.SubElement(maplayer, "layerOpacity").text = str(
        (layer.get("style") or {}).get("opacity", 1)
    )
    custom = ET.SubElement(maplayer, "customproperties")
    ET.SubElement(custom, "Option", {"type": "Map"})


# ---------------------------------------------------------------------------
# Navigation tree
# ---------------------------------------------------------------------------


def prune_tree(node: object, keep: dict[str, str]) -> object | None:
    """The navigation tree reduced to layers this archive can serve.

    Leaves are ``{id, label, a, b}`` where `id` is the layer id -- `a`/`b` are
    booleans saying whether the layer starts loaded on the left/right map.
    """
    if isinstance(node, list):
        kept = [c for c in (prune_tree(n, keep) for n in node) if c]
        return kept or None

    if not isinstance(node, dict):
        return None

    if "children" in node:
        # "Kernkaarten" is the app's cross-cutting overview group: every layer
        # in it also appears under the group it belongs to, so including it
        # would list the same layers twice in the QGIS tree.
        if (node.get("label") or "").strip().casefold() == EXCLUDED_GROUP:
            return None
        kept = [c for c in (prune_tree(n, keep) for n in node["children"]) if c]
        if not kept:
            return None
        return {"label": node.get("label", ""), "children": kept}

    layer_id = str(node.get("id", ""))
    if layer_id in keep:
        return {"label": node.get("label") or "", "layer": layer_id}
    return None


def build_tree(parent: ET.Element, nodes: list, ids: dict[str, str]) -> None:
    """Emit the tree: groups checked and open, every layer present but off.

    A group's checkbox only gates the layers inside it, so a checked group with
    all layers unchecked still draws nothing -- it just means ticking any single
    layer is enough to see it, with no second box to find first.
    """
    for node in nodes:
        if "children" in node:
            group = ET.SubElement(
                parent,
                "layer-tree-group",
                {
                    "name": node["label"],
                    # The string form: checked="1" parses as UNCHECKED, giving a
                    # project where nothing can be switched on.
                    "checked": "Qt::Checked",
                    "expanded": "1",
                    "groupLayer": "",
                },
            )
            custom = ET.SubElement(group, "customproperties")
            ET.SubElement(custom, "Option", {"type": "Map"})
            build_tree(group, node["children"], ids)
        else:
            layer_id = node["layer"]
            entry = ET.SubElement(
                parent,
                "layer-tree-layer",
                {
                    "name": node["label"].strip(),
                    "id": layer_id,
                    "source": ids[layer_id],
                    "providerKey": "ogr",
                    # Off by default: these are full-coverage national polygon
                    # layers, and drawing 20+ at once is unreadable and slow.
                    "checked": "Qt::Unchecked",
                    "expanded": "0",
                    "legend_exp": "",
                    "legend_split_behavior": "0",
                    "patch_size": "-1,-1",
                },
            )
            custom = ET.SubElement(entry, "customproperties")
            ET.SubElement(custom, "Option", {"type": "Map"})


# ---------------------------------------------------------------------------
# Project assembly
# ---------------------------------------------------------------------------


def source_basename(source: str) -> str:
    # 2025 sources carry ?v=20260822; a naive basename would keep the query and
    # match nothing.
    return urlparse(source).path.rsplit("/", 1)[-1]


def build_project(
    archive: str, year: str, layers: list[dict], gpkgs: dict[str, GeoPackage],
    navigation: list, verbose: bool,
) -> tuple[ET.ElementTree, int, list[str]]:
    root = ET.Element(
        "qgis",
        {"projectname": f"Startanalyse {year} - {ARCHIVE_LABEL[archive]}", "version": QGIS_VERSION},
    )
    ET.SubElement(root, "homePath", {"path": ""})
    ET.SubElement(root, "title").text = f"Startanalyse {year} - {ARCHIVE_LABEL[archive]}"

    project_crs = ET.SubElement(root, "projectCrs")
    _spatialrefsys(project_crs)

    tree_root = ET.SubElement(root, "layer-tree-group")
    tree_custom = ET.SubElement(tree_root, "customproperties")
    ET.SubElement(tree_custom, "Option", {"type": "Map"})

    projectlayers = ET.SubElement(root, "projectlayers")

    kept: dict[str, str] = {}
    skipped: list[str] = []
    pending: list[tuple[str, dict, GeoPackage]] = []

    for layer in layers:
        basename = source_basename(layer.get("source", ""))
        gpkg = gpkgs.get(basename.replace(".pmtiles", ".gpkg"))
        if gpkg is None:
            continue
        if not (layer.get("geostyler") or {}).get("rules"):
            skipped.append(f"{layer['id']} ({layer.get('name', '').strip()}): no style")
            continue
        layer_id = f"{archive}_{layer['id']}"
        # A layer missing one class draws a misleading map, so a single
        # unresolvable field drops the whole layer rather than the rule.
        try:
            for rule in layer["geostyler"]["rules"]:
                to_expression(rule["filter"], gpkg.resolve)
        except MissingField as exc:
            skipped.append(f"{layer['id']} ({layer.get('name', '').strip()}): {exc}")
            continue
        kept[layer_id] = gpkg.datasource
        pending.append((layer_id, layer, gpkg))

    for layer_id, layer, gpkg in pending:
        build_maplayer(projectlayers, layer, gpkg, layer_id)

    by_config_id = {lid.split("_", 1)[1]: lid for lid in kept}
    pruned = prune_tree(navigation, by_config_id) or []
    # Rewrite leaf ids from config id to project layer id.
    def relabel(nodes):
        for n in nodes:
            if "children" in n:
                relabel(n["children"])
            else:
                n["layer"] = by_config_id[n["layer"]]
    relabel(pruned)

    # Pruning "Kernkaarten" can orphan a layer that the navigation tree lists
    # only there -- LNGA08 is one. The data is in the archive, so dropping it
    # from the tree would hide a layer rather than de-duplicate one. Anything
    # left unreachable is appended so every layer stays selectable.
    def reachable(nodes, seen):
        for n in nodes:
            if "children" in n:
                reachable(n["children"], seen)
            else:
                seen.add(n["layer"])
        return seen

    orphans = [lid for lid in kept if lid not in reachable(pruned, set())]
    if orphans:
        by_id = {lid: lyr for lid, lyr, _ in pending}
        extra = [
            {"label": (by_id[lid].get("name") or lid).strip(), "layer": lid}
            for lid in orphans
        ]
        if len(pruned) == 1 and "children" in pruned[0]:
            pruned[0]["children"].extend(extra)
        else:
            pruned.extend(extra)
        if verbose:
            for lid in orphans:
                print(f"    kept {lid} ({by_id[lid].get('name', '').strip()}) "
                      f"-- listed only under an excluded group")

    # A single top-level group whose only child is the archive's own navigation
    # group would just repeat the same label twice, so in that case the
    # navigation group is used directly.
    if len(pruned) == 1 and "children" in pruned[0]:
        build_tree(tree_root, pruned, kept)
    else:
        archive_group = ET.SubElement(
            tree_root,
            "layer-tree-group",
            {"name": ARCHIVE_LABEL[archive], "checked": "Qt::Checked",
             "expanded": "1", "groupLayer": ""},
        )
        group_custom = ET.SubElement(archive_group, "customproperties")
        ET.SubElement(group_custom, "Option", {"type": "Map"})
        build_tree(archive_group, pruned, kept)

    ET.SubElement(tree_root, "custom-order", {"enabled": "0"})

    properties = ET.SubElement(root, "properties")

    # Relative paths. Without this QGIS resolves ./x.gpkg against the working
    # directory, and every layer arrives broken.
    paths = ET.SubElement(properties, "Paths")
    ET.SubElement(paths, "Absolute", {"type": "bool"}).text = "false"

    # The project CRS. `<projectCrs>` alone does NOT set it -- QGIS reads the
    # project's own CRS from here, and without this block the project opens in
    # the default EPSG:4326 and every 28992 layer has to be reprojected, which
    # is what raises the "Select Transformation" dialog on load.
    srs = ET.SubElement(properties, "SpatialRefSys")
    ET.SubElement(srs, "ProjectCRSProj4String").text = RD_NEW["proj4"]
    ET.SubElement(srs, "ProjectCRSID", {"type": "int"}).text = RD_NEW["srsid"]
    ET.SubElement(srs, "ProjectCrs").text = RD_NEW["authid"]
    ET.SubElement(properties, "ProjectionsEnabled", {"type": "int"}).text = "1"

    if verbose and skipped:
        for line in skipped:
            print(f"    skipped layer {line}")

    return ET.ElementTree(root), len(kept), skipped


def validate(tree: ET.ElementTree) -> None:
    """Catch the mistakes that yield a project which opens but draws nothing."""
    root = tree.getroot()
    layer_ids = {e.text for e in root.iterfind("./projectlayers/maplayer/id")}

    # A layer defined but absent from the tree cannot be switched on -- it is
    # invisible in the layer panel, so it may as well not ship.
    in_tree = {t.get("id") for t in root.iter("layer-tree-layer")}
    missing = layer_ids - in_tree
    if missing:
        raise AssertionError(f"layers defined but not in the tree: {sorted(missing)}")

    for entry in root.iter("layer-tree-layer"):
        if entry.get("id") not in layer_ids:
            raise AssertionError(f"tree references unknown layer {entry.get('id')}")
        # No layer starts on; the user picks. Qt::Checked here would draw a
        # full-coverage national polygon layer on open.
        if entry.get("checked") != "Qt::Unchecked":
            raise AssertionError(f"layer {entry.get('id')} is checked by default")

    for group in root.iter("layer-tree-group"):
        # The root group carries no name and no state; only named groups do.
        if group.get("name") is None:
            continue
        if group.get("checked") != "Qt::Checked":
            raise AssertionError(f"group {group.get('name')!r} is not checked")
        if group.get("expanded") != "1":
            raise AssertionError(f"group {group.get('name')!r} is not expanded")
        if (group.get("name") or "").strip().casefold() == EXCLUDED_GROUP:
            raise AssertionError(f"{group.get('name')!r} must not be in the tree")

    for maplayer in root.iterfind("./projectlayers/maplayer"):
        names = {s.get("name") for s in maplayer.iterfind("./renderer-v2/symbols/symbol")}
        for rule in maplayer.iterfind("./renderer-v2/rules/rule"):
            if rule.get("symbol") not in names:
                raise AssertionError(
                    f"{maplayer.findtext('id')}: rule symbol {rule.get('symbol')} has no symbol"
                )
    absolute = root.findtext("./properties/Paths/Absolute")
    if absolute != "false":
        raise AssertionError("Paths/Absolute must be false for relative datasources")

    # The project's own CRS, which is separate from the per-layer one. Missing,
    # the project opens in EPSG:4326 and QGIS prompts for a transformation.
    if root.findtext("./properties/SpatialRefSys/ProjectCrs") != RD_NEW["authid"]:
        raise AssertionError("properties/SpatialRefSys does not set the project CRS")
    if root.findtext("./properties/ProjectionsEnabled") != "1":
        raise AssertionError("ProjectionsEnabled must be 1")

    # Every CRS block must carry the WKT as well as the authid. Without the WKT
    # QGIS falls back to <srsid>, a row id in the reader's own srs.db, and the
    # project can open in a different CRS than the one it names.
    blocks = list(root.iterfind("./projectCrs/spatialrefsys"))
    blocks += list(root.iterfind("./projectlayers/maplayer/srs/spatialrefsys"))
    if not blocks:
        raise AssertionError("no CRS declared")
    for srs in blocks:
        if srs.findtext("authid") != RD_NEW["authid"]:
            raise AssertionError(f"CRS authid is {srs.findtext('authid')!r}")
        if srs.findtext("srid") != RD_NEW["srid"]:
            raise AssertionError(f"CRS srid is {srs.findtext('srid')!r}")
        wkt = srs.findtext("wkt") or ""
        if 'ID["EPSG",28992]' not in wkt:
            raise AssertionError("CRS block has no EPSG:28992 WKT")
        if "towgs84" in (srs.findtext("proj4") or ""):
            raise AssertionError("proj4 must not pin a legacy towgs84 shift")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--year", choices=YEARS, help="Only this year (default: both)")
    parser.add_argument("--only", help="Only archives matching this glob, e.g. 'strat*'")
    parser.add_argument("--gpkg-dir", type=Path, required=True,
                        help="Holds <year>/<archive>/*.gpkg")
    parser.add_argument("--out-dir", type=Path, required=True,
                        help="Receives <year>/<archive>.qgs")
    parser.add_argument("--config-dir", type=Path,
                        default=Path(__file__).resolve().parent.parent / "configs" / "startanalyse2026",
                        help="Where <year>/layers.json lives")
    parser.add_argument("--allow-missing", type=int, default=0,
                        help="Tolerated count of skipped layers before failing")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    years = [args.year] if args.year else list(YEARS)
    total_skipped = 0

    for year in years:
        layers_path = args.config_dir / year / "layers.json"
        nav_path = args.config_dir / year / "navigation.json"
        layers = json.loads(layers_path.read_text(encoding="utf-8"))["layers"]
        navigation = json.loads(nav_path.read_text(encoding="utf-8"))

        buckets: dict[str, list[dict]] = {}
        for layer in layers:
            archive = ARCHIVE_OF_SOURCE.get(source_basename(layer.get("source", "")))
            if archive:
                buckets.setdefault(archive, []).append(layer)

        out_year = args.out_dir / year
        out_year.mkdir(parents=True, exist_ok=True)

        for archive in sorted(buckets):
            if args.only and not fnmatch.fnmatch(archive, args.only):
                continue
            gpkg_dir = args.gpkg_dir / year / archive
            if not gpkg_dir.is_dir():
                print(f"  {year}/{archive}: no GeoPackages at {gpkg_dir}", file=sys.stderr)
                return 1
            gpkgs = {p.name: GeoPackage(p) for p in sorted(gpkg_dir.glob("*.gpkg"))}
            tree, count, skipped = build_project(
                archive, year, buckets[archive], gpkgs, navigation, not args.quiet
            )
            validate(tree)
            out = out_year / f"{archive}.qgs"
            # Indented so the project is readable and diffable; ElementTree
            # otherwise writes the whole thing as one line. Safe here because
            # no element in a .qgs carries significant text -- every value is
            # an attribute or a leaf whose whitespace QGIS strips.
            ET.indent(tree, space="  ")
            # UTF-8 is required: layer names carry the subscript 2, degree and
            # euro signs.
            tree.write(out, encoding="utf-8", xml_declaration=True)
            total_skipped += len(skipped)
            if not args.quiet:
                print(f"  {year}/{archive}.qgs: {count} layers, "
                      f"{len(gpkgs)} GeoPackage(s), {len(skipped)} skipped")

    if total_skipped > args.allow_missing:
        print(f"\n{total_skipped} layers skipped, over the --allow-missing "
              f"limit of {args.allow_missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
