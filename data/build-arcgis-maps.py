#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Build an ArcGIS Pro map file (``.mapx``) for each dataset archive.

The ArcGIS Pro counterpart of ``build-qgis-projects.py``, and built the same
way: ``configs/startanalyse2026/<year>/layers.json`` supplies the styling,
``navigation.json`` the grouping, and every layer points at the GeoPackage
sitting beside the map file in the archive. In ArcGIS Pro: *Insert > Import
Map* and pick the ``.mapx``.

A ``.mapx`` is a JSON-encoded ``CIMMapDocument``, Esri's openly documented
Cartographic Information Model (github.com/Esri/cim-spec). No ArcGIS licence is
needed to write one -- which is the whole reason for this script, since an
``.aprx`` is closed and only ArcGIS Pro can produce it.

How the app's styling maps onto CIM:

* Each layer gets a unique-value renderer whose value is an Arcade expression:
  an if-chain over the geostyler rules in config order, returning the index of
  the first rule that matches. First match is exactly how the app picks a
  rule, so -- unlike the QGIS projects -- no reordering is needed.
* Features no rule matches return null and, with no default symbol, are not
  drawn -- as in the app.
* Fills, outlines and the red-on-white hatch become CIM symbol layers.

Everything that has to agree with the QGIS projects -- which layers an archive
holds, which GeoPackage serves them, how fields resolve, the tree -- is reused
from ``build-qgis-projects.py`` rather than restated.

Usage:
    python3 build-arcgis-maps.py --gpkg-dir /tmp/downloads --out-dir /tmp/mapx

``--gpkg-dir`` is expected to hold ``<year>/<archive>/*.gpkg``; ``--out-dir``
receives ``<year>/<archive>.mapx``.
"""

from __future__ import annotations

import argparse
import fnmatch
import importlib.util
import json
import re
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

# The hyphenated filename cannot be imported by name.
_spec = importlib.util.spec_from_file_location("build_qgis_projects", DATA_DIR / "build-qgis-projects.py")
qgs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qgs)

# The document version written. ArcGIS Pro upgrades an older document on open
# but may refuse a newer one, so this names 3.0 -- the release from which the
# Pro SDK documents GeoPackage access through the `Sql` workspace factory --
# rather than the latest.
CIM_VERSION = "3.0.0"
CIM_BUILD = 36056

RD_NEW_SR = {"wkid": 28992, "latestWkid": 28992}

# MapLibre widths are CSS px; CIM sizes are points (1/72 in) at 96 dpi.
PX_TO_PT = 0.75

# What the feature-info panel titles a buurt by.
DISPLAY_FIELD = "buurtnaam"


# ---------------------------------------------------------------------------
# Colour and symbols
# ---------------------------------------------------------------------------


def cim_color(value: str | None, opacity: float = 1.0, *, fallback: str = qgs.DEFAULT_OUTLINE) -> dict:
    """A geostyler colour as a CIMRGBColor, whose alpha is a 0-100 percentage."""
    r, g, b, a = (int(c) for c in qgs.qgis_color(value, opacity, fallback=fallback).split(","))
    return {"type": "CIMRGBColor", "values": [r, g, b, round(a / 255 * 100, 2)]}


def solid_fill(color: dict) -> dict:
    return {"type": "CIMSolidFill", "enable": True, "color": color}


def solid_stroke(color: dict, width_px: float) -> dict:
    return {
        "type": "CIMSolidStroke",
        "enable": True,
        "capStyle": "Round",
        "joinStyle": "Round",
        "lineStyle3D": "Strip",
        "miterLimit": 10,
        "width": round(width_px * PX_TO_PT, 4),
        "color": color,
    }


def hatch_fill() -> dict:
    """The red diagonal stripes of src/layers/hatch-pattern.ts."""
    return {
        "type": "CIMHatchFill",
        "enable": True,
        "lineSymbol": {
            "type": "CIMLineSymbol",
            "symbolLayers": [solid_stroke(cim_color(qgs.HATCH_STRIPE), qgs.HATCH_LINE_WIDTH)],
        },
        "rotation": qgs.HATCH_ANGLE,
        "separation": round(qgs.HATCH_DISTANCE * PX_TO_PT, 4),
    }


def polygon_symbol(symbolizers: list[dict]) -> dict:
    """One rule's Fill symbolizers as a CIMPolygonSymbol.

    CIM draws symbolLayers[0] on TOP -- the reverse of QGIS -- so each
    symbolizer contributes outline, then pattern, then base fill.
    """
    layers: list[dict] = []
    for symbolizer in symbolizers:
        # The symbolizer's opacity is symbol-wide in the QGIS projects; CIM has
        # no symbol-level alpha, so it is folded into every colour instead.
        opacity = symbolizer.get("opacity", 1)
        outline = cim_color(
            symbolizer.get("outlineColor"), symbolizer.get("outlineOpacity", 1) * opacity
        )
        layers.append(solid_stroke(outline, symbolizer.get("outlineWidth", 0.3)))
        if symbolizer.get("hatch"):
            layers.append(hatch_fill())
            layers.append(solid_fill(cim_color(qgs.HATCH_BACKGROUND, opacity)))
        else:
            layers.append(solid_fill(cim_color(symbolizer.get("color"), opacity, fallback="#cccccc")))
    return {"type": "CIMPolygonSymbol", "symbolLayers": layers}


# ---------------------------------------------------------------------------
# Filters as Arcade
# ---------------------------------------------------------------------------


def arcade_literal(value: object) -> str:
    # bool before int, as in sql_literal: isinstance(True, int) is True.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    # A JSON string is a valid Arcade string literal, escapes included.
    return json.dumps(str(value), ensure_ascii=False)


def arcade_field(column: str) -> str:
    return f"$feature[{json.dumps(column, ensure_ascii=False)}]"


def to_arcade(node: object, resolve) -> str:
    """Translate one geostyler filter into an Arcade boolean expression.

    The same closed grammar as `to_expression` in build-qgis-projects.py, and
    the same two data quirks handled the same way:

    * String values are compared with their literal apostrophes stripped --
      `V01_Strategievariant` holds ``'s1a'`` with the quotes (see
      `column_ref`).
    * A comparison against an empty field is false, as SQL's NULL makes it in
      QGIS and in the app. Arcade would otherwise treat a null as 0 or "" and
      paint the feature with whatever class that happens to fall in.
    """
    if not isinstance(node, list) or not node:
        raise qgs.MissingField(f"unsupported filter node: {node!r}")

    op = node[0]

    if op in ("&&", "||"):
        joiner = f" {op} "
        return "(" + joiner.join(to_arcade(a, resolve) for a in node[1:]) + ")"

    if op == "!":
        return "!(" + to_arcade(node[1], resolve) + ")"

    if op == "has":
        return f"!IsEmpty({arcade_field(resolve(node[1]))})"

    if op in qgs.COMPARISONS:
        field = arcade_field(resolve(node[1]))
        value = node[2]
        if isinstance(value, bool):
            # GeoPackage stores BOOLEAN as the integers 0/1, and Arcade -- unlike
            # SQL -- does not equate 0 with false. Converting the field compares
            # alike whether ArcGIS reads it as a number or a boolean.
            lhs = f"Boolean({field})"
        elif isinstance(value, str):
            lhs = f"Replace({field}, \"'\", \"\")"
        else:
            lhs = field
        return f"(!IsEmpty({field}) && {lhs} {op} {arcade_literal(value)})"

    raise qgs.MissingField(f"unsupported filter operator: {op!r}")


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------


def uri(name: str) -> str:
    return "CIMPATH=map/" + re.sub(r"[^A-Za-z0-9_]", "_", name) + ".xml"


def _layer_base(name: str, layer_uri: str, visible: bool) -> dict:
    return {
        "name": name,
        "uRI": layer_uri,
        "sourceModifiedTime": {"type": "TimeInstant"},
        "useSourceMetadata": True,
        "layerType": "Operational",
        "showLegends": True,
        "visibility": visible,
        "displayCacheType": "Permanent",
        "maxDisplayCacheAge": 5,
        "showPopups": True,
        "serviceLayerID": -1,
    }


def renderer(layer: dict, gpkg) -> dict:
    rules = layer["geostyler"]["rules"]
    lines = [
        f"if ({to_arcade(rule['filter'], gpkg.resolve)}) {{ return \"{i}\" }}"
        for i, rule in enumerate(rules)
    ]
    lines.append("return null")
    classes = [
        {
            "type": "CIMUniqueValueClass",
            "label": (rule.get("name") or "").strip(),
            "patch": "Default",
            "symbol": {"type": "CIMSymbolReference", "symbol": polygon_symbol(rule.get("symbolizers") or [])},
            "values": [{"type": "CIMUniqueValue", "fieldValues": [str(i)]}],
            "visible": True,
        }
        for i, rule in enumerate(rules)
    ]
    return {
        "type": "CIMUniqueValueRenderer",
        "fields": [],
        "groups": [{"type": "CIMUniqueValueGroup", "classes": classes, "heading": ""}],
        # Off: a feature no rule claims stays unpainted, as in the app.
        "useDefaultSymbol": False,
        "valueExpressionInfo": {
            "type": "CIMExpressionInfo",
            "title": "Klasse",
            "expression": "\n".join(lines),
            "returnType": "String",
        },
        "polygonSymbolColorTarget": "Fill",
    }


def feature_layer(layer: dict, gpkg, layer_id: str) -> dict:
    opacity = (layer.get("style") or {}).get("opacity", 1)
    return {
        "type": "CIMFeatureLayer",
        **_layer_base((layer.get("name") or layer_id).strip(), uri(layer_id), False),
        "expanded": False,
        "transparency": round((1 - opacity) * 100, 2),
        "autoGenerateFeatureTemplates": True,
        "featureTable": {
            "type": "CIMFeatureTable",
            "displayField": gpkg.lookup.get(DISPLAY_FIELD, gpkg.columns[0]),
            "editable": True,
            "dataConnection": {
                "type": "CIMStandardDataConnection",
                # Relative to the map file, which ships beside the GeoPackage.
                # If ArcGIS Pro resolves it elsewhere, one *Repair Data Source*
                # fixes every layer of the same GeoPackage at once.
                "workspaceConnectionString": f"AUTHENTICATION_MODE=OSA;DATABASE=.\\{gpkg.path.name}",
                "workspaceFactory": "Sql",
                "dataset": f"main.{gpkg.table}",
                "datasetType": "esriDTFeatureClass",
            },
            "studyAreaSpatialRel": "esriSpatialRelUndefined",
            "searchOrder": "esriSearchOrderSpatial",
        },
        "htmlPopupEnabled": True,
        "selectable": True,
        "featureCacheType": "Session",
        "renderer": renderer(layer, gpkg),
        "scaleSymbols": True,
        "snappable": True,
    }


def group_layer(name: str, layer_uri: str, children: list[str]) -> dict:
    return {
        "type": "CIMGroupLayer",
        **_layer_base(name, layer_uri, True),
        "expanded": True,
        "layers": children,
    }


# ---------------------------------------------------------------------------
# Map document
# ---------------------------------------------------------------------------


def build_map(
    archive: str, year: str, layers: list[dict], gpkgs: dict, navigation: list, verbose: bool,
) -> tuple[dict, int, list[str]]:
    definitions: list[dict] = []
    skipped: list[str] = []
    pending: list[tuple[str, dict, object]] = []

    # Same selection as build_project in build-qgis-projects.py: the layers
    # whose data this archive holds, minus the unstyled click target, minus any
    # layer a single field cannot be resolved for.
    for layer in layers:
        gpkg = gpkgs.get(qgs.gpkg_name_for(qgs.source_basename(layer.get("source", ""))))
        if gpkg is None:
            continue
        if not (layer.get("geostyler") or {}).get("rules"):
            if verbose:
                print(f"    left out {layer['id']} ({layer.get('name', '').strip()}): no style")
            continue
        try:
            for rule in layer["geostyler"]["rules"]:
                to_arcade(rule["filter"], gpkg.resolve)
        except qgs.MissingField as exc:
            skipped.append(f"{layer['id']} ({layer.get('name', '').strip()}): {exc}")
            continue
        pending.append((f"{archive}_{layer['id']}", layer, gpkg))

    for layer_id, layer, gpkg in pending:
        definitions.append(feature_layer(layer, gpkg, layer_id))

    tree = qgs.navigation_tree(navigation, [(lid, lyr) for lid, lyr, _ in pending], verbose)
    if not qgs.is_single_group(tree):
        tree = [{"label": qgs.ARCHIVE_LABEL[archive], "children": tree}]

    counter = iter(range(1, 10**6))
    by_uri = {d["uRI"]: d for d in definitions}
    placed: set[str] = set()

    def emit(nodes: list) -> list[str]:
        uris = []
        for node in nodes:
            if "children" in node:
                group_uri = uri(f"group_{next(counter)}")
                definitions.append(group_layer(node["label"].strip(), group_uri, emit(node["children"])))
                uris.append(group_uri)
                continue
            layer_uri = uri(node["layer"])
            # The navigation tree may list one layer under two groups. A QGIS
            # tree can point twice at one layer; a CIM layer has exactly one
            # parent, so a second placement is a copy under its own URI.
            if layer_uri in placed:
                copy = json.loads(json.dumps(by_uri[layer_uri]))
                copy["uRI"] = uri(f"{node['layer']}_{next(counter)}")
                definitions.append(copy)
                layer_uri = copy["uRI"]
            placed.add(layer_uri)
            uris.append(layer_uri)
        return uris

    top = emit(tree)
    title = f"Startanalyse {year} - {qgs.ARCHIVE_LABEL[archive]}"
    extent = {k: float(v) for k, v in qgs.RD_NEW_EXTENT.items()}
    doc = {
        "type": "CIMMapDocument",
        "version": CIM_VERSION,
        "build": CIM_BUILD,
        "mapDefinition": {
            "type": "CIMMap",
            "name": title,
            "uRI": "CIMPATH=map/map.xml",
            "sourceModifiedTime": {"type": "TimeInstant"},
            "useSourceMetadata": True,
            "layers": top,
            "defaultViewingMode": "Map",
            "mapType": "Map",
            "defaultExtent": {**extent, "spatialReference": RD_NEW_SR},
            "spatialReference": RD_NEW_SR,
        },
        "layerDefinitions": definitions,
    }
    if verbose and skipped:
        for line in skipped:
            print(f"    skipped layer {line}")
    return doc, len(pending), skipped


def validate(doc: dict, gpkgs: dict) -> None:
    """Catch the mistakes that yield a map which imports but draws nothing."""
    defs = doc["layerDefinitions"]
    by_uri = {d["uRI"]: d for d in defs}
    if len(by_uri) != len(defs):
        raise AssertionError("duplicate layer URIs")

    referenced = list(doc["mapDefinition"]["layers"])
    for d in defs:
        if d["type"] == "CIMGroupLayer":
            if not d["layers"]:
                raise AssertionError(f"group {d['name']!r} is empty")
            referenced += d["layers"]
    if len(referenced) != len(set(referenced)):
        raise AssertionError("a layer is listed under more than one parent")
    missing = set(referenced) - set(by_uri)
    if missing:
        raise AssertionError(f"listed but not defined: {sorted(missing)}")
    orphans = set(by_uri) - set(referenced)
    if orphans:
        raise AssertionError(f"defined but unreachable: {sorted(orphans)}")

    features = [d for d in defs if d["type"] == "CIMFeatureLayer"]
    if not features:
        raise AssertionError("map has no layers")

    tables = {g.path.name: g.table for g in gpkgs.values()}
    for d in features:
        if d["visibility"]:
            raise AssertionError(f"{d['name']!r} is visible by default")
        conn = d["featureTable"]["dataConnection"]
        db = conn["workspaceConnectionString"].rsplit("\\", 1)[-1]
        if tables.get(db) is None or conn["dataset"] != f"main.{tables[db]}":
            raise AssertionError(f"{d['name']!r}: dataset {conn['dataset']!r} not in {db}")
        r = d["renderer"]
        returned = set(re.findall(r'return "(\d+)"', r["valueExpressionInfo"]["expression"]))
        values = [v for c in r["groups"][0]["classes"] for u in c["values"] for v in u["fieldValues"]]
        if not values:
            raise AssertionError(f"{d['name']!r} has no classes")
        if set(values) != returned or len(values) != len(set(values)):
            raise AssertionError(f"{d['name']!r}: class values do not match the expression")

    if doc["mapDefinition"]["spatialReference"]["wkid"] != 28992:
        raise AssertionError("map is not in RD New")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--year", choices=qgs.YEARS, help="Only this year (default: both)")
    parser.add_argument("--only", help="Only archives matching this glob, e.g. 'strat*'")
    parser.add_argument("--gpkg-dir", type=Path, required=True, help="Holds <year>/<archive>/*.gpkg")
    parser.add_argument("--out-dir", type=Path, required=True, help="Receives <year>/<archive>.mapx")
    parser.add_argument("--config-dir", type=Path,
                        default=DATA_DIR.parent / "configs" / "startanalyse2026",
                        help="Where <year>/layers.json lives")
    parser.add_argument("--allow-missing", type=int, default=0,
                        help="Tolerated count of skipped layers before failing")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    years = [args.year] if args.year else list(qgs.YEARS)
    total_skipped = 0

    for year in years:
        layers = json.loads((args.config_dir / year / "layers.json").read_text(encoding="utf-8"))["layers"]
        navigation = json.loads((args.config_dir / year / "navigation.json").read_text(encoding="utf-8"))

        buckets: dict[str, list[dict]] = {}
        for layer in layers:
            archive = qgs.ARCHIVE_OF_SOURCE.get(qgs.source_basename(layer.get("source", "")))
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
            gpkgs = {p.name: qgs.GeoPackage(p) for p in sorted(gpkg_dir.glob("*.gpkg"))}
            doc, count, skipped = build_map(
                archive, year, buckets[archive], gpkgs, navigation, not args.quiet
            )
            validate(doc, gpkgs)
            out = out_year / f"{archive}.mapx"
            # UTF-8 without escaping: layer names carry the subscript 2, degree
            # and euro signs.
            out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            total_skipped += len(skipped)
            if not args.quiet:
                print(f"  {year}/{archive}.mapx: {count} layers, "
                      f"{len(gpkgs)} GeoPackage(s), {len(skipped)} skipped")

    if total_skipped > args.allow_missing:
        print(f"\n{total_skipped} layers skipped, over the --allow-missing "
              f"limit of {args.allow_missing}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
