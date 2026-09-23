"""
Generate the layer metainfo fragments from a project's metadata.xlsx.

One spreadsheet per project lives in `data/meta/<project>/metadata.xlsx`. Every
layer with a description yields up to three fragments, one per tab of the app's
metainfo dialog:

    resultaten/<layer id>_toelichting.html
    resultaten/<layer id>_bronnen.html
    resultaten/<layer id>_aannames_en_onzekerheden.html

A route with nothing to say writes no file, and a layer's `meta` in layers.json
then simply omits that key -- which is what makes the tab disappear.

`<project>/resultaten/` is a MIRROR of what the fileserver holds, images and
all, so publishing is a plain recursive copy of its contents into
/var/www/woonzorglimburg_data/meta/ on the host serving PUBLIC_BASE. The
documents live there rather than in the repo: they are content, re-generated
whenever the spreadsheet changes, and a repo is the wrong place to version
something nobody reviews as code.

The fragments carry no page furniture (no <head>, no dialog chrome, no tab strip
and no <script>): the app injects them with innerHTML, which never executes
script, and the dialog they land in already provides all of that. See README.md.

Run it with `npm run metainfo`, optionally naming a single project:

    python data/meta/genereer_html.py woonzorglimburg
"""

import re
import shutil
import sys
import warnings
from pathlib import Path

try:
    import openpyxl
except ModuleNotFoundError:
    sys.exit(
        "openpyxl is required to read metadata.xlsx.\n"
        "Install it with:  pip install openpyxl pillow"
    )

warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent.parent

TEMPLATE_DIR = BASE_DIR / "template"
AFBEELDINGEN_DIR = BASE_DIR / "afbeeldingen"
# Documents written by hand rather than generated from a spreadsheet. Copied
# into the mirror verbatim so `resultaten/` stays a complete picture of what the
# fileserver should hold -- otherwise they would live only on the server, with
# no version of them anywhere.
HANDMATIG_DIR = BASE_DIR / "handmatig"

# Where the published documents are served from. The app is on a different
# origin (map.woonzorglimburg.nl), so every URL a fragment carries has to be
# ABSOLUTE: a root-relative path would resolve against the app instead, and a
# document-relative one against whatever route the single-page app is showing.
#
# The data host already sends `Access-Control-Allow-Origin: *`, and both app
# vhosts already list it in their CSP `connect-src`, so fetching these
# cross-origin needs no server change.
PUBLIC_BASE = "https://data.woonzorglimburg.nl/meta/"

FRAGMENT_IMG_BASE = PUBLIC_BASE + "afbeeldingen/"

# The explanatory diagrams are ~1300px PNGs of a few MB each, shown a few
# hundred pixels wide in a dialog. Downscaling and converting to WebP cuts them
# by about 95% with nothing visible lost at that size.
DIAGRAM_MAX_WIDTH = 800
DIAGRAM_QUALITY = 82

# Sibling folders holding a dated copy of somebody's working spreadsheet. They
# contain a metadata.xlsx too, so without this they would generate as if each
# were a project of its own.
STAGING_PREFIX = "metainformatie_concept_"

# The dialog's tabs, in the order they appear. The middle item is the template,
# the last the placeholders whose emptiness decides whether the route has
# anything to show -- an empty route writes no file, so no tab appears.
ROUTES = [
    ("toelichting", "fragment_toelichting.html", ("WAT_ZIET_U", "KAARTLAAGTYPE_CONTENT")),
    ("bronnen", "fragment_bronnen.html", ("BRONNEN",)),
    ("aannames_en_onzekerheden", "fragment_aannames.html", ("AANNAMES_EN_ONZEKERHEDEN",)),
]


def lees_sheet_data(wb, sheet_name):
    real_sheet_name = next(
        (name for name in wb.sheetnames
         if name.strip().lower() == sheet_name.lower()),
        None,
    )
    if not real_sheet_name:
        return []

    rows = list(wb[real_sheet_name].iter_rows(values_only=True))
    if not rows:
        return []

    header_idx = None
    headers = []
    for idx, row in enumerate(rows[:10]):
        cleaned = [str(c).strip() if c is not None else "" for c in row]
        if sum(1 for c in cleaned if c) >= 2:
            headers = cleaned
            header_idx = idx
            break

    if header_idx is None:
        return []

    data = []
    for row in rows[header_idx + 1:]:
        row_dict = {}
        for h, val in zip(headers, row):
            if h:
                str_val = str(val).strip() if val is not None else ""
                row_dict[h] = "" if str_val.lower() in ("nan", "none") else str_val
        if any(row_dict.values()):
            data.append(row_dict)

    return data


def escape_html(value):
    value = str(value or "")
    return (value.replace("&", "&amp;")
                 .replace("<", "&lt;")
                 .replace(">", "&gt;")
                 .replace('"', "&quot;"))


def format_text(value):
    """
    Metadata descriptions may contain HTML such as <a> and <br>.
    All links receive the standard link styling automatically.
    """
    html = str(value or "")

    def style_link(match):
        tag = match.group(0)

        # Heeft de link al een class, vul die aan in plaats van te vervangen.
        if re.search(r'\bclass\s*=', tag, re.IGNORECASE):
            tag = re.sub(
                r'class\s*=\s*"([^"]*)"',
                lambda m: f'class="{m.group(1)} underline hover:text-blue-800"',
                tag,
                count=1,
                flags=re.IGNORECASE,
            )
        else:
            tag = tag.replace(
                "<a",
                '<a class="underline hover:text-blue-800"',
                1,
            )

        # Nog geen style: geef de link de primaire kleur.
        if not re.search(r'\bstyle\s*=', tag, re.IGNORECASE):
            tag = tag.replace(
                ">",
                ' style="color: var(--primary-color);">',
                1,
            )

        return tag

    return re.sub(r"<a\b[^>]*>", style_link, html, flags=re.IGNORECASE)


def bron_logo_url(logo):
    """
    A source logo's path, rooted at FRAGMENT_IMG_BASE.

    The spreadsheet's Logo column carries a "../afbeeldingen/" prefix, written
    back when these documents were standalone pages sitting next to the images.
    Strip it before re-prefixing, or the result is
    ".../meta/afbeeldingen/../afbeeldingen/iconen/osm.png".
    """
    if not logo:
        return ""
    logo = str(logo).strip()

    # Absolute URL: use unchanged.
    if re.match(r"^https?://", logo, re.I):
        return logo

    logo = re.sub(r"^(\.\./)*afbeeldingen/", "", logo.lstrip("/\\"), flags=re.I)
    return FRAGMENT_IMG_BASE + logo


def herschrijf_afbeeldingen(html):
    """
    Point the spreadsheet's inline <img> sources at FRAGMENT_IMG_BASE.

    The kaartlaagtype descriptions embed their diagrams as HTML written back
    when these were standalone pages, so the paths are relative. A fragment is
    injected into a single-page app on another origin, where a relative path
    resolves against whatever URL happens to be showing -- it must be a full
    URL. The diagrams are also converted to WebP on the way out, so the
    extension moves with them.
    """
    html = re.sub(
        r'(src\s*=\s*")(?:\.\./)*afbeeldingen/',
        lambda m: m.group(1) + FRAGMENT_IMG_BASE,
        html,
        flags=re.I,
    )
    return re.sub(
        rf'(src\s*=\s*"{re.escape(FRAGMENT_IMG_BASE)}kaartlaagtypen/[^"]+)\.png"',
        r'\1.webp"',
        html,
        flags=re.I,
    )


def maak_bronnen_html(kaartlaag_id, df_kaartlagen_bronnen, bronnen_dict):
    """
    The source rows for one layer, or "" when it has none.

    Empty rather than a "geen databronnen geregistreerd" placeholder: an empty
    route writes no file, and the dialog then shows no Bronnen tab at all --
    which says the same thing without a tab that leads to an apology.
    """
    gekoppelde_bronnen = [
        kb for kb in df_kaartlagen_bronnen
        if kb.get("Naam van de laag", "").strip() == kaartlaag_id
    ]

    if not gekoppelde_bronnen:
        return ""

    html = []

    for kb in gekoppelde_bronnen:
        b_naam = (kb.get("Naam van de bron", "") or "").strip()
        datum = kb.get("Datum", "")
        b_info = bronnen_dict.get(b_naam, {})

        houder = b_info.get("Bronhouder", "")
        beschrijving = b_info.get("Beschrijving", "")
        url = b_info.get("URL", "")
        logo = bron_logo_url(b_info.get("Logo", ""))

        titel = escape_html(b_naam)
        houder_html = escape_html(houder)
        datum_html = escape_html(datum)
        link_html = escape_html(url)

        if link_html:
            titel_html = f"""
                  <div class="flex items-center justify-between gap-2 mb-0.5">
                    <h4 class="dro-card-title font-semibold text-gray-900 text-sm">{titel}</h4>
                    <a href="{link_html}" target="_blank" rel="noopener"
                       class="text-xs font-semibold hover:underline flex items-center gap-1"
                       style="color: var(--primary-color);">
                      Bekijk bron &rsaquo;
                    </a>
                  </div>
            """
        else:
            titel_html = f"""
                  <h4 class="dro-card-title font-semibold text-gray-900 text-sm mb-0.5">{titel}</h4>
            """

        logo_html = ""
        if logo:
            logo_html = f"""
                    <img src="{escape_html(logo)}"
                         alt="Logo {titel}"
                         class="max-h-full max-w-full object-contain"
                         onerror="this.style.display='none';">
            """

        # No `even:bg-gray-100` here. Tailwind only scans source files, and these
        # documents are fetched at runtime, so a utility used nowhere else in the
        # app is purged from the build and the striping silently disappears. The
        # app styles these rows itself, scoped to `.dro-meta` in src/index.css.
        html.append(f"""
        <tr class="border-b border-gray-200">
          <td class="align-top pr-4 py-3">
            {logo_html}
          </td>

          <td class="align-top p-3">
            {titel_html}

            <div class="text-xs text-gray-500 mb-1">
              <span class="font-medium text-gray-700">Bronhouder:</span> {houder_html}
              <span aria-hidden="true"> | </span>
              <span class="font-medium text-gray-700">Datum:</span> {datum_html}
            </div>

            <p class="text-xs leading-relaxed text-gray-600">
              {format_text(beschrijving)}
            </p>
          </td>
        </tr>""")

    return "\n".join(html)


def vervang_template(html, key, content):
    pattern_if = re.compile(
        rf"\{{%\s*if\s+{re.escape(key)}\s*%\}}(.*?)\{{%\s*endif\s*%\}}",
        re.DOTALL,
    )

    if content and str(content).strip():
        html = pattern_if.sub(r"\1", html)
        html = re.sub(
            rf"\{{\{{\s*{re.escape(key)}\s*\}}\}}",
            lambda m: str(content),
            html,
        )
    else:
        html = pattern_if.sub("", html)
        html = re.sub(
            rf"\{{\{{\s*{re.escape(key)}\s*\}}\}}",
            "",
            html,
        )

    return html


def lees_templates():
    """The three route templates, each with the shared title card inlined."""
    kop = (TEMPLATE_DIR / "_kop.html").read_text(encoding="utf-8")
    templates = {}
    for route, filename, _ in ROUTES:
        path = TEMPLATE_DIR / filename
        if not path.exists():
            raise FileNotFoundError(f"Template-bestand niet gevonden: {path}")
        templates[route] = vervang_template(path.read_text(encoding="utf-8"), "KOP", kop)
    return templates


def genereer_project(project_dir, templates):
    """Render every layer of one project's spreadsheet. Returns (written, skipped)."""
    wb = openpyxl.load_workbook(project_dir / "metadata.xlsx", data_only=True)

    output_dir = project_dir / "resultaten"
    output_dir.mkdir(parents=True, exist_ok=True)

    df_kaartlaag = lees_sheet_data(wb, "kaartlaag")
    df_kaartlaagtypen = lees_sheet_data(wb, "kaartlaagtypen")
    df_bronnen = lees_sheet_data(wb, "bronnen")
    df_kaartlagen_bronnen = lees_sheet_data(wb, "kaartlagen_bronnen")

    kaartlaagtypen_dict = {
        row.get("Naam van het kaartlaagtype", ""): row.get("Beschrijving", "")
        for row in df_kaartlaagtypen
        if row.get("Naam van het kaartlaagtype")
    }

    bronnen_dict = {
        (row.get("Naam de bron", "") or row.get("Naam van de bron", "")).strip(): row
        for row in df_bronnen
        if (row.get("Naam de bron", "") or row.get("Naam van de bron", ""))
    }

    written = 0
    skipped = 0

    for row in df_kaartlaag:
        layer_id = row.get("Naam van de laag", "").strip()

        if (
            not layer_id
            or layer_id.lower().startswith("algemene informatie")
            or layer_id.lower().startswith("naam van")
        ):
            continue

        safe_filename = re.sub(r'[\\/*?:"<>|]', "_", layer_id).strip()

        wat_ziet_u = row.get("Wat ziet u?", "")

        # A layer with no "Wat ziet u?" has only a title and a theme in the
        # spreadsheet. A dialog showing nothing but those reads as broken,
        # whereas no metainfo at all leaves the info button disabled -- which is
        # the honest signal. Such a layer gets no files, and starts getting them
        # the moment somebody writes its description.
        if not wat_ziet_u.strip():
            skipped += 1
            continue

        waarden = {
            "TITEL": escape_html(row.get("Titel") or layer_id),
            "THEMA_SUBTHEMA": escape_html(
                (row.get("Thema / Subthema") or "Algemeen").replace(";", " ›")
            ),
            "WAT_ZIET_U": format_text(wat_ziet_u),
            "KAARTLAAGTYPE_CONTENT": format_text(
                kaartlaagtypen_dict.get(row.get("Gekozen kaartlaagtype", ""), "")
            ),
            "AANNAMES_EN_ONZEKERHEDEN": format_text(
                row.get("Aannames en Onzekerheden", "")
            ),
            "BRONNEN": maak_bronnen_html(layer_id, df_kaartlagen_bronnen, bronnen_dict),
        }

        for route, _, keys in ROUTES:
            # Nothing to say on this tab -- no file, and layers.json omits the key.
            if not any(waarden[key].strip() for key in keys):
                continue

            html = templates[route]
            for key, content in waarden.items():
                html = vervang_template(html, key, content)

            # The inline images come from the spreadsheet's own HTML, so they are
            # rewritten after rendering rather than by the template.
            path = output_dir / f"{safe_filename}_{route}.html"
            path.write_text(herschrijf_afbeeldingen(html), encoding="utf-8")
            written += 1

    return written, skipped


def kopieer_handmatig(output_dir):
    """Add the hand-written documents to the mirror."""
    if not HANDMATIG_DIR.is_dir():
        return 0
    count = 0
    for document in sorted(HANDMATIG_DIR.glob("*.html")):
        shutil.copy2(document, output_dir / document.name)
        count += 1
    return count


def kopieer_afbeeldingen(output_dir):
    """
    Put the images the fragments point at into the mirror.

    Icons are a few KB each and are copied as they are. The kaartlaagtype
    diagrams are ~1300px PNGs totalling several MB, displayed a few hundred
    pixels wide -- they are downscaled and converted to WebP, which takes about
    95% off with nothing visible lost.
    """
    img_dst = output_dir / "afbeeldingen"

    icon_src = AFBEELDINGEN_DIR / "iconen"
    if icon_src.is_dir():
        shutil.copytree(icon_src, img_dst / "iconen", dirs_exist_ok=True)

    diagram_src = AFBEELDINGEN_DIR / "kaartlaagtypen"
    if not diagram_src.is_dir():
        return

    try:
        from PIL import Image
    except ModuleNotFoundError:
        sys.exit(
            "Pillow is required to convert the diagram images.\n"
            "Install it with:  pip install openpyxl pillow"
        )

    diagram_dst = img_dst / "kaartlaagtypen"
    diagram_dst.mkdir(parents=True, exist_ok=True)
    before = after = 0
    for png in sorted(diagram_src.glob("*.png")):
        before += png.stat().st_size
        image = Image.open(png)
        if image.width > DIAGRAM_MAX_WIDTH:
            height = round(image.height * DIAGRAM_MAX_WIDTH / image.width)
            image = image.resize((DIAGRAM_MAX_WIDTH, height), Image.LANCZOS)
        target = diagram_dst / f"{png.stem}.webp"
        image.convert("RGB").save(target, "WEBP", quality=DIAGRAM_QUALITY, method=6)
        after += target.stat().st_size

    if before:
        print(f"Afbeeldingen: {before / 1024:.0f} KB -> {after / 1024:.0f} KB")


def vind_projecten(gevraagd):
    """Project folders under data/meta that hold a metadata.xlsx."""
    if gevraagd:
        dirs = [BASE_DIR / name for name in gevraagd]
        ontbreekt = [d.name for d in dirs if not (d / "metadata.xlsx").exists()]
        if ontbreekt:
            sys.exit(f"Geen metadata.xlsx gevonden voor: {', '.join(ontbreekt)}")
        return dirs

    return sorted(
        path.parent
        for path in BASE_DIR.glob("*/metadata.xlsx")
        if not path.parent.name.startswith(STAGING_PREFIX)
    )


def main():
    projecten = vind_projecten(sys.argv[1:])
    if not projecten:
        sys.exit(f"Geen projecten met een metadata.xlsx gevonden in {BASE_DIR}")

    templates = lees_templates()

    totaal = 0
    for project_dir in projecten:
        written, skipped = genereer_project(project_dir, templates)
        output_dir = project_dir / "resultaten"
        kopieer_afbeeldingen(output_dir)
        handmatig = kopieer_handmatig(output_dir)
        totaal += written
        print(
            f"{project_dir.name}: {written} fragmenten "
            f"(+{handmatig} handmatig, "
            f"{skipped} kaartlagen zonder beschrijving overgeslagen)"
        )

    print(f"Klaar: {totaal} fragmenten.")
    print("Uploaden met (zie README.md):")
    for project_dir in projecten:
        print(f"  scp -r {project_dir / 'resultaten'}/* cicada@37.97.169.242:/var/www/woonzorglimburg_data/meta/")


if __name__ == "__main__":
    main()
