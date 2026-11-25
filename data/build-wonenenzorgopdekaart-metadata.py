#!/usr/bin/env python3
"""Fill ``data/meta/wzw5/wonenenzorgopdekaart/metadata.xlsx`` for every layer in
wonenenzorgopdekaart's navigation.

The spreadsheet was seeded with only the Kennemerland (``kl_*``) layers by
``build-kl-metadata.py``. This script adds every other layer and tidies the kl
rows, drawing on two sources, in this order of preference:

1. **woonzorglimburg's spreadsheet** (``data/meta/woonzorglimburg/metadata.xlsx``)
   — the tried texts, kaartlaagtypen (with their diagrams) and source records —
   wherever a layer here is the same kind of layer: leefbaarometer, woningbouw,
   geschiktheid, voorzieningen, loopafstanden, CBS boundaries and the population
   prognosis. Its Limburg-specific wording is rewritten; the run fails if any
   "Limburg" survives.
2. **MapGallery** (``data/wzw5_mapgallery/``) for the details of the national
   data: each layer's ``metadata`` HTML, found via the Noord-Holland collection
   (185) and, for voorzieningen Noord-Holland lacks, Noord-Brabant (186).

The ``kl_*`` rows are kept from the spreadsheet itself (they are its own content):
mojibake and typos are repaired, rows for layers no longer in the navigation are
dropped, and shared sources (BAG, BRT, AHN, OSM) get woonzorglimburg's records.
Rows for every other layer are regenerated on each run, so re-running is safe —
but an edit made by hand to one of those rows is overwritten. Edit the kl rows
freely; change the others here.

    python data/build-wonenenzorgopdekaart-metadata.py
    python data/meta/genereer_html.py wzw5/wonenenzorgopdekaart
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
META = HERE / "meta"
PROJECT = META / "wzw5" / "wonenenzorgopdekaart"
TARGET = PROJECT / "metadata.xlsx"
WZL = META / "woonzorglimburg" / "metadata.xlsx"
CONFIG = HERE.parent / "configs" / "objectvision" / "wonenenzorgopdekaart"
MAPGALLERY = HERE / "wzw5_mapgallery"
ICONS = META / "afbeeldingen" / "iconen"
PROJECT_JSON = {
    "public_base": "https://data.derondekaart.nl/meta/woonzorgwijzer/",
    "upload": "ov-data:/var/www/objectvision_data/meta/woonzorgwijzer/",
}
FIRST_DATA_ROW = 5  # rows 1-4: title, explanation, blank, header
SHEETS = ("kaartlaag", "kaartlaagtypen", "bronnen", "kaartlagen_bronnen")

# ---------------------------------------------------------------- sources

# MapGallery spells some sources differently from woonzorglimburg; the
# woonzorglimburg record wins, so map MapGallery's name onto it. (MapGallery's
# "BGT" entry describes the BRT, which is what is used.)
CANON = {
    "Basis registratie Adressen en Gebouwen (BAG)": "Basisregistratie Adressen en Gebouwen (BAG)",
    "Basisregistratie Topografie (BGT)": "Basisregistratie Topografie (BRT)",
    "Basis registratie Topografie (BRT)": "Basisregistratie Topografie (BRT)",
    "hoogtekaart Nederland": "Algemeen Hoogebestand Nederland (AHN)",
    "Algemeen Hoogtebestand Nederland (AHN)": "Algemeen Hoogebestand Nederland (AHN)",
    "wegenbestand": "OpenStreetMap",
    "Open OV": "OVapi GTFS Nederland",
    # build-kl-metadata.py carried both spellings over from the old pages.
    "LISA vestigingen registratie, voorzieningen zijn handmatig gecntroleerd en aangepast in 2025":
        "LISA vestigingen registratie, voorzieningen zijn handmatig gecontroleerd en aangepast in 2025",
    "Kamer van Koophandel (KvK), WebServices, voorzieningen zijn handmatig gecntroleerd en aangepast in 2025":
        "Kamer van Koophandel (KvK), WebServices, voorzieningen zijn handmatig gecontroleerd en aangepast in 2025",
}

# Records this project needs that neither spreadsheet has, or has only in a
# Limburg form. Logos only where a local icon exists: MapGallery's own logo URLs
# are other people's hosts, and the Noord-Holland one answers 403.
EXTRA_SOURCES = {
    "Bevolkings- en woningbehoefteprognose Noord-Holland": {
        "bronhouder": "Provincie Noord-Holland",
        "url": "https://bevolkingsprognose.noordholland.nl",
        "logo": None,
    },
    "Basisregistratie Topografie (BRT)": {
        "bronhouder": "Kadaster",
        "omschrijving": "De BRT is een landsdekkende topografische vlakkenkaart, die samen met de BAG wordt "
                        "gebruikt om het bebouwd gebied te bepalen.",
        "url": "https://www.kadaster.nl/zakelijk/registraties/basisregistraties/brt",
        "logo": "../afbeeldingen/iconen/kadaster.png",
    },
    "Locaties van buurt- en dorpshuizen": {
        "bronhouder": "Object Vision, op basis van Google Maps en de Digitale Sociale Kaart",
        "omschrijving": "Adresbestand opgebouwd door in Google Maps te zoeken op de termen 'buurthuis' en "
                        "'dorpshuis', aangevuld met de voorzieningen op de Digitale Sociale Kaart.",
        "url": "https://www.digitale-sociale-kaart.nl",
        "logo": "../afbeeldingen/iconen/objectvision.png",
    },
    "CBS Gebiedsindelingen": {
        "bronhouder": "Centraal Bureau voor de Statistiek",
        "url": "https://www.cbs.nl/nl-nl/dossier/nederland-regionaal/geografische-data",
        "logo": "../afbeeldingen/iconen/cbs.png",
    },
}

# ---------------------------------------------------------------- text helpers

MOJIBAKE = re.compile(r"[ÃÂâ][\x80-\xbfŒ-™]")

TYPOS = {
    "dichtsbijzijnde": "dichtstbijzijnde",
    "ontmoetingcentrum": "ontmoetingscentrum",
    "verblijsobject": "verblijfsobject",
    "verblijsfobjecten": "verblijfsobjecten",
    "gebruiksoppervlake ": "gebruiksoppervlakte ",
    "geinterpoleerd": "geïnterpoleerd",
    "visualsiatie": "visualisatie",
    "gecntroleerd": "gecontroleerd",
    " atijd ": " altijd ",
    "de dichtstbijzijnde buurt- of dorpshuis": "het dichtstbijzijnde buurt- of dorpshuis",
}


def demojibake(value):
    """Undo UTF-8 read as cp1252 ("coÃ¶rdinaten" -> "coördinaten"), run by run."""
    if not isinstance(value, str) or not MOJIBAKE.search(value):
        return value

    def fix(match: re.Match) -> str:
        try:
            return match.group(0).encode("cp1252").decode("utf-8")
        except UnicodeError:
            return match.group(0)

    return re.sub(r"[ÃÂâ][\x80-\xbfŒ-™]+", fix, value)


def tidy(value):
    if not isinstance(value, str):
        return value
    value = demojibake(value)
    for wrong, right in TYPOS.items():
        value = value.replace(wrong, right)
    return value


def clean_html(fragment: str) -> str:
    """MapGallery HTML -> the inline HTML the spreadsheet cells carry."""
    s = re.sub(r"(?is)<head>.*?</head>|</?font[^>]*>|</?u>", "", fragment)
    s = re.sub(r"(?i)<br\s*/?>", "<br>", s)
    s = re.sub(r"(?i)<p>\s*", "", s)
    s = re.sub(r"(?i)</p>", "<br><br>", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"(\s*<br>\s*){3,}", "<br><br>", s)
    s = re.sub(r"^(\s*<br>\s*)+|(\s*<br>\s*)+$", "", s)
    return s.strip()


# ---------------------------------------------------------------- MapGallery

def load_mapgallery():
    layers = {l["id"]: l for l in json.loads((MAPGALLERY / "MapGallery_layers_export.json").read_text(encoding="utf-8"))}
    collections = json.loads((MAPGALLERY / "MapGallery_collections_export.json").read_text(encoding="utf-8"))
    return layers, {c["id"]: c for c in collections}


def collection_items(collection: dict) -> dict[str, int]:
    """'<bookmark>/<item title>' -> MapGallery layer id."""
    out = {}
    for bookmark in collection["bookmarks"]:
        for item in bookmark["items"]:
            layer = item.get("layer")
            layer = layer.get("id") if isinstance(layer, dict) else layer
            if layer:
                out[f"{bookmark['title']}/{item['title'].strip()}"] = layer
    return out


FIELD = r"<(?:b|strong)>\s*([A-Za-z]+)\s*:\s*</(?:b|strong)>"


def parse_sources(fragment: str) -> list[dict]:
    """The source tables of either MapGallery metadata layout."""
    sources = []
    for table in re.findall(r"(?is)<table.*?</table>", fragment):
        cells = re.findall(r"(?is)<td[^>]*>(.*?)</td>", table)
        body = cells[-1] if cells else ""
        name = re.search(r"(?is)<(?:b|strong)>\s*([^<:]+?)\s*</(?:b|strong)>", body)
        if not name:
            continue
        fields = {}
        next_field = FIELD.replace("([A-Za-z]+)", "[A-Za-z]+")
        for key, value in re.findall(rf"(?is){FIELD}\s*(.*?)(?={next_field}|$)", body):
            fields[key.lower()] = value
        link = re.search(r'(?is)href\s*=\s*"([^"]+)"', fields.get("url", ""))
        img = re.search(r'(?is)<img[^>]*src="([^"]+)"', table)
        bronhouder = clean_html(fields.get("bronhouder", ""))
        sources.append({
            "naam": clean_html(name.group(1)),
            "bronhouder": bronhouder,
            "datum": clean_html(fields.get("datum", "")),
            "omschrijving": clean_html(fields.get("omschrijving", "")),
            "url": link.group(1).strip() if link else None,
            "logo": local_logo(img.group(1), bronhouder) if img else None,
        })
    return sources


def local_logo(url: str, bronhouder: str = ""):
    """A local icon for a MapGallery logo — but MapGallery uses the Kadaster
    logo as a placeholder for sources that have nothing to do with it, so that
    one only counts when the Kadaster really is the bronhouder."""
    name = url.rsplit("/", 1)[-1].split("?")[0]
    if name == "kadaster.png" and "Kadaster" not in bronhouder:
        return None
    return f"../afbeeldingen/iconen/{name}" if (ICONS / name).is_file() else None


def parse_metadata(html: str) -> dict:
    """{'omschrijving', 'bewerking', 'peildata', 'bronnen'} from a layer's metadata."""
    s = re.sub(r"\s+", " ", html or "")
    if 'class="h5"' in s:
        sections = dict(re.findall(r'<div class="h5">\s*([^<]+?)\s*</div>\s*<hr>(.*?)(?=<div class="h5">|$)', s))
        return {
            "omschrijving": clean_html(sections.get("Omschrijving", "")),
            "bewerking": clean_html(sections.get("Bewerking", "")),
            "peildata": clean_html(sections.get("Peildata", "")),
            "bronnen": parse_sources(sections.get("Bronnen", "")),
        }
    match = re.search(r"(?is)<b>\s*Omschrijving:\s*</b>(.*?)(?:<b>\s*Bronnen:\s*</b>|$)", s)
    head = match.group(1) if match else ""
    rest = s[match.end():] if match else s
    return {"omschrijving": clean_html(head), "bewerking": "", "peildata": "", "bronnen": parse_sources(rest)}


# ---------------------------------------------------------------- workbook io

def data_rows(ws) -> list[list]:
    return [list(r) for r in ws.iter_rows(min_row=FIRST_DATA_ROW, values_only=True) if r and r[0]]


def clear(ws) -> None:
    if ws.max_row >= FIRST_DATA_ROW:
        ws.delete_rows(FIRST_DATA_ROW, ws.max_row - FIRST_DATA_ROW + 1)


def nav_leaves() -> list[tuple[str, tuple[str, ...], str]]:
    nav = json.loads((CONFIG / "navigation.json").read_text(encoding="utf-8"))
    out = []

    def walk(nodes, path):
        for node in nodes:
            if "children" in node:
                walk(node["children"], path + (node["label"],))
            elif node.get("id"):
                out.append((node["id"], path, node.get("label", "")))

    walk(nav, ())
    return out


# ---------------------------------------------------------------- layer rows

GENERIC_LOC_AANNAMES = (
    "<ul><li>De locaties zijn gekoppeld aan de BAG op basis van postcode en huisnummer; adressen die niet in "
    "de BAG gevonden worden, ontbreken op de kaart.</li><li>Het adresbestand is een afspiegeling van de "
    "werkelijkheid en daarmee niet per definitie actueel en/of volledig: locaties kunnen inmiddels gewijzigd "
    "zijn.</li></ul>"
)

# id suffix -> (MapGallery key, plural, title)
VRZ_LOCATIES = {
    "huisarts": ("nh", "voorzieningen/huisarts", "huisartsen", "Locaties van huisartsen"),
    "supermarkt": ("nh", "voorzieningen/supermarkt", "supermarkten", "Locaties van supermarkten"),
    "openbaar_vervoer": ("nh", "voorzieningen/openbaar vervoer", "haltes van het openbaar vervoer",
                         "Locaties van haltes van het openbaar vervoer"),
    "fysiotherapeut": ("nb", "voorzieningen/fysiotherapeut", "fysiotherapeuten", "Locaties van fysiotherapeuten"),
    "ziekenhuis": ("nb", "voorzieningen/ziekenhuis", "ziekenhuizen", "Locaties van ziekenhuizen"),
    "buurt_en_dorpshuizen": ("nb", "voorzieningen/buurt- en dorpshuizen", "buurt- en dorpshuizen",
                             "Locaties van buurt- en dorpshuizen"),
}
# loop suffix -> (woonzorglimburg row, locaties suffix whose source it uses)
VRZ_LOOP = {
    "huisarts": ("loopafstand_huisarts", "huisarts"),
    "ontmoeting": ("loopafstand_ontmoeting", "buurt_en_dorpshuizen"),
    "ov": ("loopafstand_ov", "openbaar_vervoer"),
    "supermarkt": ("loopafstand_supermarkt", "supermarkt"),
    "fysiotherapeut": ("loopafstand_fysiotherapeut", "fysiotherapeut"),
}
GESCHIKTHEID = {"nultrede": "aandeel_geschikt_2024", "aanpasbaar": "aandeel_aanpasbaar_2024",
                "ongeschikt": "aandeel_ongeschikt_2024"}
AGE = {  # bevprog suffix -> (phrase, title part)
    "00_17": ("0- tot 17-jarigen", "0 - 17 jarigen"),
    "18_29": ("18- tot 29-jarigen", "18 - 29 jarigen"),
    "30_44": ("30- tot 44-jarigen", "30 - 44 jarigen"),
    "45_66": ("45- tot 66-jarigen", "45 - 66 jarigen"),
    "67_75": ("67- tot 74-jarigen", "67 - 74 jarigen"),
    "67_plus": ("67-plussers", "67-plussers"),
    "75_plus": ("75-plussers", "75-plussers"),
}
GI_MAPGALLERY = {"gi_provincie": "provincie", "gi_ggd": "GGD regio", "gi_iza": "integraal zorgakkoord regio",
                 "gi_jr": "jeugdregio", "gi_rho": "regionale huisartsenorganisatie (RHO)",
                 "gi_vtr": "veilig thuis regio", "gi_wd": "woondealregio", "gi_zkr": "zorgkantoorregio"}
GI_WZL = {"gi_gemeente": "cbsgemeente2026", "gi_wijk": "cbswijk2026", "gi_buurt": "cbsbuurt2026"}

WONINGBOUW_DEFINITIE = {
    "zacht": "De laag toont de <b>zachte</b> woningbouwplannen: plannen die nog niet door de gemeenteraad zijn "
             "vastgesteld, zoals plannen in voorbereiding of in de ideefase. Elke stip is één woningbouwplan, "
             "ingedeeld naar betaalbaarheidscategorie (sociale huur, middenhuur, dure huur, betaalbare koop, dure "
             "koop of onbekend).",
    "ouderen": "De laag toont de woningbouwplannen met woningen die <b>geschikt zijn voor ouderen</b>: "
               "nultredenwoningen (geclusterd of niet, met of zonder zorg) en andere woonvormen voor ouderen. "
               "Elke stip is één woningbouwplan, ingedeeld naar het type ouderenwoning.",
}


class Builder:
    def __init__(self, wzl, mg_layers, collections):
        self.wzl_rows = {r[0]: r for r in data_rows(wzl["kaartlaag"])}
        self.wzl_types = {r[0]: r[1] for r in data_rows(wzl["kaartlaagtypen"])}
        self.wzl_sources = {r[0]: r for r in data_rows(wzl["bronnen"])}
        self.wzl_links = data_rows(wzl["kaartlagen_bronnen"])
        self.mg = mg_layers
        self.items = {"nh": collection_items(collections[185]), "nb": collection_items(collections[186])}
        self.nh_ids = [
            (item["layer"].get("id") if isinstance(item["layer"], dict) else item["layer"])
            for bookmark in collections[185]["bookmarks"] for item in bookmark["items"] if item.get("layer")
        ]
        self.sources: dict[str, list] = {}  # name -> [naam, bronhouder, beschrijving, url, logo]
        self.extra_types: dict[str, str] = {}

    # sources ---------------------------------------------------------
    def source(self, record: dict) -> str:
        """Register a source; woonzorglimburg's record for that name wins."""
        name = CANON.get(record["naam"], record["naam"])
        if name in self.sources:
            return name
        if name in self.wzl_sources:
            self.sources[name] = list(self.wzl_sources[name][:5])
        else:
            extra = EXTRA_SOURCES.get(name, {})
            self.sources[name] = [
                name,
                extra.get("bronhouder") or record.get("bronhouder") or None,
                extra.get("omschrijving") or record.get("omschrijving") or None,
                extra.get("url") or record.get("url") or None,
                extra.get("logo", record.get("logo")),
            ]
        return name

    def mg_meta(self, collection: str, key: str) -> dict:
        return parse_metadata(self.mg[self.items[collection][key]]["metadata"])

    def mg_links(self, meta: dict) -> list[tuple[str, str]]:
        return [(self.source(s), s["datum"]) for s in meta["bronnen"]]

    def wzl(self, name: str):
        row = self.wzl_rows[name]
        return row[1], row[3], row[4], row[5]

    # families ----------------------------------------------------------
    def wzw5(self, layer: dict, label: str):
        stem = layer["sourceLayer"].replace("_%YEAR%", "")
        mg_id = next(i for i in self.items["nh"].values() if self.mg[i]["layername"] == f"{stem}_v3")
        meta = parse_metadata(self.mg[mg_id]["metadata"])
        if meta["bewerking"]:
            self.extra_types.setdefault("woonzorgwijzer5_cbs_microdata_infact", (
                "Stichting In.Fact berekent de kans op het voorkomen van de doelgroep uit de CBS microdata.<br><br>"
                + meta["bewerking"]
                + '<br><br>De ruimtelijke patronen zijn berekend met de <a href="https://www.geodms.nl" '
                  'target="_blank" rel="noopener">GeoDMS software</a>.'))
        wat = meta["omschrijving"]
        if meta["peildata"]:
            wat += "<br><br>" + meta["peildata"]
        return layer["name"], wat, "woonzorgwijzer5_cbs_microdata_infact", None, self.mg_links(meta)

    def bevprog(self, layer_id: str):
        absolute = "_absoluut_" in layer_id
        suffix = re.sub(r"^bevprog_(?:percentage_p|absoluut)_lft", "", layer_id)
        phrase, title_part = AGE[suffix]
        # One MapGallery layer per block (all ages share it), and the block's two
        # halves repeat the same item titles — so look it up by layername.
        layername = f"bevprog_nh_{'absoluut' if absolute else 'percentage'}_v1"
        mg_id = next(i for i in self.nh_ids if self.mg[i]["layername"] == layername)
        meta = parse_metadata(self.mg[mg_id]["metadata"])
        if absolute:
            title = f"Aantal {title_part}"
            wat = f"De laag toont het aantal {phrase} als ruimtelijk patroon."
            kind = "demografie_aantal_prognose_model_infact"
            if kind not in self.extra_types:
                text = self.wzl_types["demografie_prognose_model_infact"]
                text = re.sub(r"\s*Het aandeel wordt berekend als.*?inwoners\.<br>", "<br>", text, flags=re.S)
                self.extra_types[kind] = text
        else:
            title = f"Aandeel {title_part} op de totale populatie"
            wat = f"De laag toont het aandeel {phrase} als ruimtelijk patroon."
            kind = "demografie_prognose_model_infact"
        wat += ("\nVia de legenda kiest u het prognosejaar (2024 tot en met 2045) of bekijkt u de ontwikkeling in "
                "de tijd als animatie.<br><br>De prognose volgt de bevolkings- en woningbehoefteprognose van de "
                "Provincie Noord-Holland (2025).")
        return title, wat, kind, None, self.mg_links(meta)

    def vrz_locatie(self, suffix: str):
        collection, key, plural, title = VRZ_LOCATIES[suffix]
        meta = self.mg_meta(collection, key)
        body = re.sub(r"^Locaties van [^<]*? in Nederland\s*(<br>\s*)*", "", meta["omschrijving"])
        body = re.sub(r"\s*<br>\s*Voor de regionale WoonZorgwijzer Rivierenland.*?(<br>|$)", "", body)
        wat = f"De symbolen tonen de vestigingsadressen van {plural} in Nederland."
        if body:
            wat += "<br><br>" + body
        aannames = GENERIC_LOC_AANNAMES
        # MapGallery copied the "Huisartsen" source into the fysiotherapeut and
        # ziekenhuis layers, changing only its description; give each its own.
        for s in meta["bronnen"]:
            if s["naam"] == "Huisartsen" and suffix != "huisarts":
                s["naam"] = f"{plural.capitalize()} (zorgkaartnederland.nl)"
                s["url"] = f"https://www.zorgkaartnederland.nl/{'fysiotherapeut' if suffix == 'fysiotherapeut' else 'ziekenhuis'}"
            elif s["naam"] == "Huisartsen":
                s["naam"] = "Huisartsen (zorgkaartnederland.nl)"
        links = self.mg_links(meta)
        if suffix == "openbaar_vervoer":
            wat = ("De symbolen tonen de haltes en stations van het openbaar vervoer (bus, tram, metro, trein en "
                   "veerpont) in Nederland.<br><br>" + body)
            aannames = ("<ul><li>De haltes komen uit de dienstregeling (GTFS); haltes kunnen inmiddels zijn "
                        "verplaatst, toegevoegd of opgeheven.</li><li>De laag toont waar haltes liggen, niet hoe "
                        "vaak en wanneer er vervoer rijdt.</li></ul>")
        elif suffix == "supermarkt":
            aannames = self.wzl_rows["supermarkt"][5].replace(" (Q3 2026)", "")
            # MapGallery lists every chain as a source of its own; woonzorglimburg
            # has one record for "the chains' websites", which reads far better.
            chain = next((d for n, d in links if "BAG" not in n), "")
            bag = [(n, d) for n, d in links if "BAG" in n]
            links = [(self.source({"naam": "Locaties van supermarkten"}), chain)] + bag
        elif suffix == "buurt_en_dorpshuizen":
            links = [(self.source({"naam": "Locaties van buurt- en dorpshuizen"}), "")] + links
        return title, wat, "voorziening_locaties", aannames, links

    def vrz_loop(self, suffix: str):
        wzl_name, loc = VRZ_LOOP[suffix]
        title, wat, kind, aannames = self.wzl(wzl_name)
        if suffix == "ontmoeting":
            title = title.replace("ontmoetingsplek", "buurt- of dorpshuis")
            wat = wat.replace("ontmoetingsplek", "buurt- of dorpshuis")
            aannames = aannames.replace("ontmoetingsplekken", "buurt- en dorpshuizen")
        wat += ("<br><br>Het is voor ouderen (en sommige andere doelgroepen) belangrijk dat voorzieningen binnen "
                "loopafstand liggen. Daarbij wordt vaak gesteld dat 10 tot 20 minuten lopen acceptabel is. Ouderen "
                "kunnen in 10 minuten gemiddeld zo'n 675 meter lopen, jongere leeftijden rond de 900 meter.")
        loop_meta = self.mg_meta("nh", "voorzieningen/loopafstand huisarts")
        locatie_links = self.vrz_locatie(loc)[4]
        links = [l for l in locatie_links if "BAG" not in l[0]] + self.mg_links(loop_meta)
        return title, wat, kind, aannames, links

    def geschiktheid(self, suffix: str):
        title, wat, kind, aannames = self.wzl(GESCHIKTHEID[suffix])
        wat = wat.replace("<B>geschik</B>t", "<B>geschikt</B>").replace("<B> ongeschikt</B>", "<B>ongeschikt</B>")
        meta = self.mg_meta("nh", "woningvoorraad/nultrede")
        definitie = re.sub(r"\s*De exacte definities.*?(<br>|$)", r"\1", meta["omschrijving"])
        wat += "<br><br>" + definitie
        return title, wat, kind, aannames, self.mg_links(meta)

    def woningbouw(self, suffix: str):
        title, wat, kind, aannames = self.wzl(f"woningbouw_{suffix}")
        wat = re.sub(r"\s*in Limburg,\s*", ", ", wat)
        if suffix in WONINGBOUW_DEFINITIE:
            wat = WONINGBOUW_DEFINITIE[suffix] + wat[wat.index("<br><br>"):]
        links = [(name, datum) for _, name, datum in
                 (r for r in self.wzl_links if r[0] == "woningbouw_hard")]
        return title, wat, kind, aannames, [(self.source({"naam": n}), d) for n, d in links]

    def gi(self, layer_id: str):
        if layer_id in GI_WZL:
            title, wat, kind, aannames = self.wzl(GI_WZL[layer_id])
            title = title.replace(" 2026", "")
            wat = wat.replace(", volgens de CBS indeling van 2026", ", volgens de CBS-indeling")
            meta = self.mg_meta("nh", "gebiedsindelingen/provincie")
            return title, wat, kind, aannames, self.mg_links(meta)
        mg_layer = self.mg[self.items["nh"][f"gebiedsindelingen/{GI_MAPGALLERY[layer_id]}"]]
        meta = parse_metadata(mg_layer["metadata"])
        # Some carry only a one-line description, without the Omschrijving block.
        wat = meta["omschrijving"] if "Omschrijving" in (mg_layer["metadata"] or "") else mg_layer["description"]
        if layer_id == "gi_wd":
            wat = ("In 2022 en 2023 zijn 35 regionale woondeals gesloten tussen het Rijk, provincies en gemeenten. "
                   "De deals vormen de komende jaren de basis voor de volkshuisvestelijke opgave in de 35 "
                   "woondealregio's; de laag toont hun indeling.")
        links = self.mg_links(meta) or [(self.source({"naam": "CBS Gebiedsindelingen"}), "najaar 2025")]
        return None, wat, "administratieve_grenzen", None, links

    def lbm(self, layer_id: str):
        title, wat, kind, aannames = self.wzl(layer_id)
        links = [(self.source({"naam": r[1]}), r[2]) for r in self.wzl_links if r[0] == layer_id]
        return title, wat, kind, aannames, links

    def row(self, layer: dict, label: str):
        i = layer["id"]
        if i.startswith("wzw5_"):
            return self.wzw5(layer, label)
        if i.startswith("bevprog_"):
            return self.bevprog(i)
        if i.startswith("wzw_vrz_loop_"):
            return self.vrz_loop(i.removeprefix("wzw_vrz_loop_"))
        if i.startswith("wzw_vrz_"):
            return self.vrz_locatie(i.removeprefix("wzw_vrz_"))
        if i.startswith("wzw_geschiktheid_"):
            return self.geschiktheid(i.removeprefix("wzw_geschiktheid_"))
        if i.startswith("wzw_woningbouw_"):
            return self.woningbouw(i.removeprefix("wzw_woningbouw_"))
        if i.startswith("gi_"):
            return self.gi(i)
        if i.startswith("lbm_"):
            return self.lbm(i)
        raise SystemExit(f"error: no metainfo rule for layer {i}")


KL_TYPES = {"kl_pand_bouwjaar": "bouwjaar_panden_bag", "kl_pand_woningtype": "pandtype_panden_bag",
            "kl_pand_el": "energielabel_panden"}
KL_TEXT = {"kl_wijkteam_velsen": "Verzorgingsgebied Wijkteam Velsen"}


def main(argv: list[str]) -> int:
    wzl = openpyxl.load_workbook(WZL)
    wb = openpyxl.load_workbook(TARGET)
    sheets = {name: wb[name] for name in SHEETS}
    kl_rows = {r[0]: r for r in data_rows(sheets["kaartlaag"]) if str(r[0]).startswith("kl_")}
    kl_links = [r for r in data_rows(sheets["kaartlagen_bronnen"]) if str(r[0]).startswith("kl_")]
    kl_sources = {tidy(r[0]): r for r in data_rows(sheets["bronnen"])}

    layers = {l["id"]: l for l in json.loads((CONFIG / "layers.json").read_text(encoding="utf-8"))["layers"]}
    mg_layers, collections = load_mapgallery()
    b = Builder({n: wzl[n] for n in SHEETS}, mg_layers, collections)

    kaartlaag, koppeling, used_types = [], [], set()
    for layer_id, path, label in nav_leaves():
        thema = "; ".join(path)
        if layer_id.startswith("kl_"):
            if layer_id not in kl_rows:
                raise SystemExit(f"error: {layer_id} is in the navigation but has no row to keep")
            r = [tidy(c) for c in kl_rows[layer_id][:6]]
            r[2] = thema
            r[3] = KL_TEXT.get(layer_id, r[3])
            r[4] = r[4] or KL_TYPES.get(layer_id)
            kaartlaag.append(r)
            for _, original, datum in (x[:3] for x in kl_links if x[0] == layer_id):
                name = CANON.get(tidy(original), tidy(original))
                if name not in b.wzl_sources and name not in EXTRA_SOURCES:
                    src = kl_sources.get(tidy(original)) or kl_sources.get(name) or [name, None, None, None, None]
                    record = [name] + [tidy(c) for c in src[1:5]]
                    if record[1] == "CBS" and not record[4]:
                        record[4] = "../afbeeldingen/iconen/cbs.png"
                    b.sources.setdefault(name, record)
                b.source({"naam": name})
                koppeling.append([layer_id, name, tidy(datum)])
        else:
            title, wat, kind, aannames, links = b.row(layers[layer_id], label)
            kaartlaag.append([layer_id, tidy(title or label), thema, tidy(wat), kind, tidy(aannames)])
            seen = set()
            for name, datum in links:
                if name not in seen:
                    seen.add(name)
                    koppeling.append([layer_id, name, datum])
        if kaartlaag[-1][4]:
            used_types.add(kaartlaag[-1][4])

    types = {**b.wzl_types, **b.extra_types}
    missing = sorted(used_types - set(types))
    if missing:
        raise SystemExit(f"error: kaartlaagtypen without a description: {missing}")

    rows_types = [[t, types[t]] for t in sorted(used_types)]
    rows_sources = [b.sources[n] for n in sorted({r[1] for r in koppeling})]

    hits = [f"{sheet}: {str(cell)[:80]}" for sheet, rows in
            (("kaartlaag", kaartlaag), ("kaartlaagtypen", rows_types), ("bronnen", rows_sources))
            for row in rows for cell in row
            if isinstance(cell, str) and "Limburg" in cell]
    if hits:
        raise SystemExit("error: Limburg-specific text left:\n  " + "\n  ".join(hits))

    for ws, rows in zip((sheets[n] for n in SHEETS), (kaartlaag, rows_types, rows_sources, koppeling)):
        clear(ws)
        for r in rows:
            ws.append(r)
    wb.save(TARGET)
    (PROJECT / "project.json").write_text(json.dumps(PROJECT_JSON, indent=2) + "\n", encoding="utf-8")
    print(f"{TARGET}: {len(kaartlaag)} kaartlagen, {len(rows_types)} kaartlaagtypen, "
          f"{len(rows_sources)} bronnen, {len(koppeling)} koppelingen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
