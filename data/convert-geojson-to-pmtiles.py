#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "gdal>=3.8",
#   "tqdm>=4.66",   # optional: only for folder-mode progress, degrades to prints
# ]
# ///
"""Convert GeoJSON to PMTiles (a single-file MVT tile archive) via GDAL.

PMTiles packs a whole ``{z}/{x}/{y}`` vector-tile pyramid into ONE file that a
browser reads with HTTP Range requests — the same tiles the ``"mvt"`` format
entry consumes today, but without a directory of millions of ``.pbf`` files on
the server. Unlike the other converters in this folder, which each write one
flat table (``convert-geojson-to-parquet.py`` / ``-geoparquet`` / ``-arrow``) or
one spatially-indexed file (``convert-geojson-to-flatgeobuf.py``), this one
builds a *generalized pyramid*: geometry is re-clipped and re-simplified per
tile, so what a client downloads is bounded by the viewport at every zoom.
``convert-tif-to-cog.py`` is its raster counterpart.

Accepts either a single ``.geojson``/``.json`` file, **a folder** (one layer per
file), or an explicit ``--layer``/``--spec`` composition — but always writes ONE
``.pmtiles`` archive, because a tile archive holds many named layers. This is a
deliberate departure from the sibling scripts' one-output-per-input folder mode.

Requires the GDAL Python bindings (``osgeo``), which are NOT a plain pip
install on Windows. Run it under an environment that has them:

    # Windows / OSGeo4W (what this script was developed against):
    cmd /c "call C:\\OSGeo4W\\bin\\o4w_env.bat && python convert-geojson-to-pmtiles.py ..."

    # conda:
    conda install -c conda-forge gdal

The ``uv run`` shortcut the sibling scripts advertise will generally NOT work
here — ``gdal`` has no usable PyPI wheel on Windows:
    uv run convert-geojson-to-pmtiles.py

Layer composition
-----------------
Layers are declared with repeatable ``--layer NAME=PATH[@MINZOOM-MAXZOOM]``
flags (or a JSON ``--spec`` file for larger setups). ``@`` separates the zoom
band rather than ``:``, and the name is split off at the FIRST ``=``, so
Windows paths (``C:\\data\\x.geojson``) and hyphenated filenames stay
unambiguous.

Zoom bands (CONF)
-----------------
Several input files can feed ONE output layer, each covering a different zoom
range — the point being to serve coarse/generalized geometry when zoomed out
and full detail when zoomed in, under a single layer name the style refers to.
This maps onto the PMTiles driver's ``CONF`` option: each input becomes its own
OGR layer (``panden_lod0``, ``panden_lod1``, ...) sharing a ``target_name``.

Bands within a layer must be mutually exclusive; overlapping ones are rejected
(they would emit both geometries into the same tiles). Gaps are allowed but
warned about — no tiles are produced for a layer in an uncovered zoom range.

Note that the archive's ``vector_layers`` metadata reports the **union** of a
target layer's bands (a 6-11 + 12-14 split is advertised as ``6-14``), not the
per-band split. The banding is real — it governs which source contributes tiles
at which zoom — it is simply not visible in that metadata field.

Attributes are copied as-is apart from lowercasing field names. Unlike the
sibling converters there is NO numeric downcasting and NO ring-winding
normalization, deliberately: MVT stores attributes as varints (so a narrower
integer dtype costs exactly the same bytes), and GDAL re-clips and
re-tessellates every polygon per tile (so input winding does not survive).
Expect an extra ``mvt_id`` field in the output, and features that straddle a
tile boundary to appear once per tile they touch — both are normal for MVT.

Usage:
    # Single file -> single layer named after the file stem
    python3 convert-geojson-to-pmtiles.py ov.geojson ov.pmtiles --minzoom 6 --maxzoom 14

    # Different files -> different layers, one archive
    python3 convert-geojson-to-pmtiles.py --output limburg.pmtiles \\
        --layer panden=panden.geojson --layer punten=punten.geojson

    # Different files -> different zoom levels WITHIN one layer
    python3 convert-geojson-to-pmtiles.py --output panden.pmtiles \\
        --layer panden=panden_simplified.geojson@6-11 \\
        --layer panden=panden_detail.geojson@12-14

    # Whole folder -> one layer per .geojson, all in one archive
    python3 convert-geojson-to-pmtiles.py path/to/folder out.pmtiles

    # Larger setups: the same thing as a JSON spec file
    python3 convert-geojson-to-pmtiles.py --spec layers.json --output out.pmtiles

The ``--spec`` file mirrors the flags:
    {
      "panden": [
        { "file": "panden_simplified.geojson", "minzoom": 6,  "maxzoom": 11 },
        { "file": "panden_detail.geojson",     "minzoom": 12, "maxzoom": 14 }
      ],
      "punten": "punten.geojson"
    }

Serving
-------
PMTiles is gzip-compressed INTERNALLY (tiles, directories and metadata each
carry their own gzip). The server must therefore serve ``.pmtiles`` with
``Accept-Ranges: bytes``, CORS-exposed ``Content-Range``, and **runtime gzip
switched off** — re-compressing would disable Range requests (which the format
depends on entirely) and make clients double-decompress. That is the same
treatment ``.parquet``/``.tif`` already get in ``server/setup_fileserver.sh``;
``.pmtiles`` still needs adding to that location block and to the MIME types.

After conversion, a layer entry would look like:
    {
      "id": "panden",
      "name": "Panden",
      "source": "https://data.woonzorglimburg.nl/pmtiles/panden.pmtiles",
      "format": "pmtiles",
      "sourceLayer": "panden",
      "geometryType": "polygon",
      "style": { "opacity": 0.8 }
    }
...except ``format: "pmtiles"`` is NOT supported by the app yet. It needs a
``"pmtiles"`` member in ``LayerFormat`` (``src/layers/types.ts``) and
``VALID_FORMATS`` (``src/layers/config.ts``), the ``pmtiles`` npm package, and a
``maplibregl.addProtocol("pmtiles", ...)`` registration — modelled on the COG
protocol wiring in ``src/hooks/use-map-layers.ts``. Until then this script is
for producing/inspecting archives and for serving them to other clients.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover - optional in a bare GDAL environment
    # tqdm only drives folder-mode progress output. GDAL environments (OSGeo4W)
    # frequently lack it, and it isn't worth failing a conversion over — fall
    # back to plain prints with the same call surface (`tqdm.write`).
    class tqdm:  # type: ignore[no-redef]
        def __init__(self, iterable=None, **_kwargs):
            self._iterable = iterable if iterable is not None else []

        def __iter__(self):
            return iter(self._iterable)

        @staticmethod
        def write(message: str) -> None:
            print(message)


HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "ov.geojson"
GEOJSON_SUFFIXES = (".geojson", ".json")

# Tile pyramid depth. 14 is the usual practical maximum for polygon data served
# to a web map: MapLibre overzooms beyond a source's maxzoom, so deeper levels
# mostly add build time and file size rather than visible detail.
DEFAULT_MINZOOM = 0
DEFAULT_MAXZOOM = 14

# PMTiles/MVT is always Web Mercator; the driver reprojects on its own (passing
# dstSRS makes GDAL warn "Target SRS not taken into account"). Inputs without a
# CRS are treated as EPSG:4326 — silently by GDAL, loudly by us.
ASSUMED_EPSG = 4326


def import_gdal():
    """Import the GDAL Python bindings, or explain how to get them.

    Kept in a function (rather than a module-level import) so ``--help`` and
    argument validation still work in an environment without ``osgeo``.
    """
    try:
        from osgeo import gdal, ogr
    except ImportError as err:  # pragma: no cover - environment dependent
        raise SystemExit(
            "error: this script needs the GDAL Python bindings (osgeo), which are not\n"
            "       importable in the current interpreter.\n"
            "  Windows/OSGeo4W:  cmd /c \"call C:\\OSGeo4W\\bin\\o4w_env.bat && python "
            f"{Path(__file__).name} ...\"\n"
            "  conda:            conda install -c conda-forge gdal\n"
            f"  (import error: {err})"
        ) from err

    gdal.UseExceptions()
    ogr.UseExceptions()
    return gdal, ogr


@dataclass
class LayerSource:
    """One input file contributing to one output layer, over a zoom band."""

    name: str
    path: Path
    minzoom: int | None = None
    maxzoom: int | None = None

    @property
    def band(self) -> str:
        if self.minzoom is None and self.maxzoom is None:
            return "all zooms"
        return f"z{self.minzoom if self.minzoom is not None else '*'}-{self.maxzoom if self.maxzoom is not None else '*'}"


def parse_layer_arg(value: str) -> LayerSource:
    """Parse ``NAME=PATH[@MINZOOM-MAXZOOM]``.

    Split at the FIRST ``=`` and use ``@`` (not ``:``) for the band, so drive
    letters and hyphenated filenames stay unambiguous.
    """
    if "=" not in value:
        raise argparse.ArgumentTypeError(
            f"--layer must be NAME=PATH[@MINZOOM-MAXZOOM], got: {value!r}"
        )
    name, _, rest = value.partition("=")
    name = name.strip()
    if not name:
        raise argparse.ArgumentTypeError(f"--layer has an empty layer name: {value!r}")

    minzoom = maxzoom = None
    if "@" in rest:
        rest, _, band = rest.rpartition("@")
        lo, _, hi = band.partition("-")
        if not hi:
            raise argparse.ArgumentTypeError(
                f"--layer zoom band must be MINZOOM-MAXZOOM, got: {band!r}"
            )
        try:
            minzoom, maxzoom = int(lo), int(hi)
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"--layer zoom band must be two integers, got: {band!r}"
            ) from None
        if minzoom > maxzoom:
            raise argparse.ArgumentTypeError(
                f"--layer zoom band has minzoom > maxzoom: {band!r}"
            )

    path = Path(rest.strip())
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    return LayerSource(name=name, path=path, minzoom=minzoom, maxzoom=maxzoom)


def load_spec(spec_path: Path) -> list[LayerSource]:
    """Load a JSON spec: ``{layer: "file"}`` or ``{layer: [{file, minzoom, maxzoom}]}``."""
    # utf-8-sig: editors on Windows routinely save JSON with a BOM, which the
    # plain utf-8 codec surfaces as a confusing "Unexpected UTF-8 BOM" error.
    data = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("spec must be a JSON object mapping layer name -> source(s)")

    sources: list[LayerSource] = []
    for name, entry in data.items():
        entries = entry if isinstance(entry, list) else [entry]
        for item in entries:
            if isinstance(item, str):
                item = {"file": item}
            if not isinstance(item, dict) or "file" not in item:
                raise ValueError(f"layer {name!r}: each source needs a \"file\" key")
            path = Path(item["file"])
            if not path.is_absolute():
                # Relative paths resolve against the spec file, not the cwd —
                # a spec next to its data stays portable.
                path = (spec_path.parent / path).resolve()
            sources.append(
                LayerSource(
                    name=name,
                    path=path,
                    minzoom=item.get("minzoom"),
                    maxzoom=item.get("maxzoom"),
                )
            )
    return sources


def group_sources(sources: list[LayerSource]) -> dict[str, list[LayerSource]]:
    """Group by layer name, preserving declaration order within each layer."""
    grouped: dict[str, list[LayerSource]] = {}
    for src in sources:
        grouped.setdefault(src.name, []).append(src)
    return grouped


def validate_sources(grouped: dict[str, list[LayerSource]], log=print) -> list[str]:
    """Check inputs exist and zoom bands don't overlap. Returns error strings."""
    errors: list[str] = []
    for name, sources in grouped.items():
        for src in sources:
            if not src.path.exists():
                errors.append(f"layer {name!r}: input not found: {src.path}")

        if len(sources) < 2:
            continue

        # Overlapping bands would put both geometries in the same tiles — the
        # easiest mistake to make with this feature, so it's an error not a warning.
        banded = sorted(
            ((s.minzoom if s.minzoom is not None else 0,
              s.maxzoom if s.maxzoom is not None else DEFAULT_MAXZOOM, s)
             for s in sources),
            key=lambda t: t[0],
        )
        for (lo_a, hi_a, a), (lo_b, hi_b, b) in zip(banded, banded[1:]):
            if lo_b <= hi_a:
                errors.append(
                    f"layer {name!r}: zoom bands overlap between "
                    f"{a.path.name} (z{lo_a}-{hi_a}) and {b.path.name} (z{lo_b}-{hi_b})"
                )
            elif lo_b > hi_a + 1:
                log(
                    f"  Warning: layer {name!r} has no source for z{hi_a + 1}-{lo_b - 1} "
                    f"(gap between {a.path.name} and {b.path.name})"
                )
    return errors


def build_conf(grouped: dict[str, list[LayerSource]]) -> tuple[dict[str, str], dict]:
    """Map each source to its staged OGR layer name, and build the CONF JSON.

    Returns ``(staged_names, conf)`` where ``staged_names`` keys are
    ``f"{id(source)}"``-stable staged layer names in declaration order. Layers
    with a single source keep their plain name and contribute no CONF entry, so
    the simple case produces no configuration at all.
    """
    staged: dict[str, str] = {}
    conf: dict[str, dict] = {}

    for name, sources in grouped.items():
        if len(sources) == 1:
            src = sources[0]
            staged[_key(src)] = name
            # A lone source still needs CONF when it carries its own band.
            if src.minzoom is not None or src.maxzoom is not None:
                entry: dict[str, object] = {"target_name": name}
                if src.minzoom is not None:
                    entry["minzoom"] = src.minzoom
                if src.maxzoom is not None:
                    entry["maxzoom"] = src.maxzoom
                conf[name] = entry
            continue

        for i, src in enumerate(sources):
            layer_name = f"{name}_lod{i}"
            staged[_key(src)] = layer_name
            entry = {"target_name": name}
            if src.minzoom is not None:
                entry["minzoom"] = src.minzoom
            if src.maxzoom is not None:
                entry["maxzoom"] = src.maxzoom
            conf[layer_name] = entry

    return staged, conf


def _key(src: LayerSource) -> str:
    """Stable identity for a source within one run."""
    return f"{src.name}\x00{src.path}\x00{src.minzoom}\x00{src.maxzoom}"


def _lowercased_layer(dataset, layer):
    """Return ``(layer, result_set)`` with all field names lowercased.

    Field definitions are sealed once a layer is copied (GDAL >= 3.9 raises
    ``SetName() not allowed on a sealed object``), so the rename has to happen
    during selection. ``result_set`` is None when nothing needed renaming — the
    caller only releases it when it isn't.
    """
    defn = layer.GetLayerDefn()
    names = [defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())]
    if all(n == n.lower() for n in names):
        return layer, None

    selected = ", ".join(f'"{n}" AS "{n.lower()}"' for n in names)
    result = dataset.ExecuteSQL(f'SELECT {selected} FROM "{layer.GetName()}"')
    if result is None:
        # Fall back to the original names rather than failing the conversion.
        return layer, None
    return result, result


def stage_sources(
    grouped: dict[str, list[LayerSource]],
    staged_names: dict[str, str],
    ogr,
    log=print,
) -> tuple[object, list[object], int]:
    """Copy every input into one in-memory OGR dataset, one layer per source.

    PMTiles is write-once — a layer cannot be appended to an existing archive —
    so every source has to be present in a single dataset before the one
    translate call that builds the pyramid.

    Returns ``(memory_dataset, open_source_datasets, total_features)``. The
    source datasets are returned so the caller keeps them alive: releasing a
    parent dataset while a staged layer still references its spatial reference
    raises ``TypeError: in method 'Layer_GetSpatialRef'``.
    """
    mem_driver = ogr.GetDriverByName("Memory")
    mem_ds = mem_driver.CreateDataSource("staging")
    keep_alive: list[object] = []
    total = 0

    for name, sources in grouped.items():
        for src in sources:
            layer_name = staged_names[_key(src)]
            in_ds = ogr.Open(str(src.path))
            if in_ds is None:
                raise RuntimeError(f"GDAL could not open {src.path}")
            keep_alive.append(in_ds)

            in_layer = in_ds.GetLayer(0)
            if in_layer is None:
                raise RuntimeError(f"{src.path} contains no layer")

            if in_layer.GetSpatialRef() is None:
                log(f"  Warning: {src.path.name} has no CRS — assuming EPSG:{ASSUMED_EPSG}")

            # Lowercase field names on the way in (house convention across the
            # converters). Field definitions are sealed once copied, so do the
            # renaming with a SELECT ... AS aliasing pass and stage its result.
            source_layer, result_set = _lowercased_layer(in_ds, in_layer)
            out_layer = mem_ds.CopyLayer(source_layer, layer_name)
            if result_set is not None:
                in_ds.ReleaseResultSet(result_set)
            if out_layer is None:
                raise RuntimeError(f"failed to stage {src.path.name} as {layer_name!r}")

            count = out_layer.GetFeatureCount()
            total += count
            log(f"  {layer_name}: {count} feature(s) from {src.path.name} [{src.band}]")

    return mem_ds, keep_alive, total


def convert(
    grouped: dict[str, list[LayerSource]],
    output_path: Path,
    minzoom: int,
    maxzoom: int,
    log=print,
    name: str | None = None,
    description: str | None = None,
    simplification: float | None = None,
    max_size: int | None = None,
    max_features: int | None = None,
) -> None:
    """Build one PMTiles archive from the grouped layer sources.

    ``log`` is the sink for progress messages — ``print`` for single-file mode,
    ``tqdm.write`` in folder mode so it doesn't corrupt the progress bar.
    """
    gdal, ogr = import_gdal()

    n_sources = sum(len(v) for v in grouped.values())
    log(f"Reading  {n_sources} input file(s) -> {len(grouped)} layer(s)")

    staged_names, conf = build_conf(grouped)
    mem_ds, keep_alive, total = stage_sources(grouped, staged_names, ogr, log=log)

    options = [
        f"MINZOOM={minzoom}",
        f"MAXZOOM={maxzoom}",
        f"NAME={name or output_path.stem}",
    ]
    if description:
        options.append(f"DESCRIPTION={description}")
    if conf:
        options.append("CONF=" + json.dumps(conf))
    if simplification is not None:
        options.append(f"SIMPLIFICATION={simplification}")
    if max_size is not None:
        options.append(f"MAX_SIZE={max_size}")
    if max_features is not None:
        options.append(f"MAX_FEATURES={max_features}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        # The driver refuses to overwrite; make re-runs idempotent.
        output_path.unlink()

    band_note = f", {len(conf)} CONF entr{'y' if len(conf) == 1 else 'ies'}" if conf else ""
    log(f"Writing  {output_path} (z{minzoom}-{maxzoom}, {total} feature(s){band_note})")

    out_ds = None
    try:
        # One translate builds the whole pyramid: the driver clips, simplifies
        # and reprojects to Web Mercator itself (do NOT pass dstSRS).
        out_ds = gdal.VectorTranslate(
            str(output_path),
            mem_ds,
            format="PMTiles",
            datasetCreationOptions=options,
        )
        if out_ds is None:
            raise RuntimeError("GDAL VectorTranslate returned no dataset")
    finally:
        # Flush and release in dependency order (output, staging, then inputs).
        out_ds = None
        mem_ds = None
        keep_alive.clear()

    size = output_path.stat().st_size
    log(f"Wrote {output_path.name} ({size:,} bytes)")

    # Report what actually landed in the archive — layer merging via CONF means
    # the output layer list can be shorter than the input file count.
    check = ogr.Open(str(output_path))
    if check is not None:
        try:
            names = [check.GetLayer(i).GetName() for i in range(check.GetLayerCount())]
            log(f"  Layers: {', '.join(names)}")
        finally:
            check = None


def convert_folder(
    input_dir: Path,
    output_path: Path,
    minzoom: int,
    maxzoom: int,
    **kwargs,
) -> int:
    """Convert every GeoJSON in ``input_dir`` into ONE archive, one layer per file.

    Unlike the sibling converters' folder mode (one output per input), a tile
    archive holds many layers, so the whole folder collapses into a single
    ``.pmtiles``. Layer names are the file stems, lowercased.

    Returns 1 on failure, 0 on success.
    """
    files = sorted(
        p for p in input_dir.iterdir()
        if p.is_file() and p.suffix.lower() in GEOJSON_SUFFIXES
    )
    if not files:
        print(f"error: no .geojson/.json files found in {input_dir}", file=sys.stderr)
        return 1

    print(f"Converting {len(files)} file(s) from {input_dir} -> {output_path}")
    sources = [LayerSource(name=p.stem.lower(), path=p) for p in files]
    grouped = group_sources(sources)

    errors = validate_sources(grouped, log=tqdm.write)
    if errors:
        for err in errors:
            print(f"error: {err}", file=sys.stderr)
        return 1

    try:
        convert(grouped, output_path, minzoom, maxzoom, log=tqdm.write, **kwargs)
    except Exception as err:
        print(f"error converting {input_dir.name}: {err}", file=sys.stderr)
        return 1

    print(f"Done: {len(files)} layer(s) written")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Convert GeoJSON to PMTiles (single-file MVT tile archive) via GDAL.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        default=None,
        help=(
            "Input GeoJSON path or folder of GeoJSONs "
            f"(default: {DEFAULT_INPUT.name}; omit when using --layer/--spec)"
        ),
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="Output .pmtiles path (default: input path with .pmtiles suffix)",
    )
    parser.add_argument(
        "-o", "--output-file",
        dest="output_flag",
        default=None,
        metavar="PATH",
        help="Output .pmtiles path (required with --layer/--spec)",
    )
    parser.add_argument(
        "--layer",
        action="append",
        default=[],
        type=parse_layer_arg,
        metavar="NAME=PATH[@MIN-MAX]",
        help=(
            "Add a source to a named layer, optionally limited to a zoom band. "
            "Repeat to build several layers, or to give one layer several "
            "zoom-banded sources."
        ),
    )
    parser.add_argument(
        "--spec",
        default=None,
        metavar="PATH",
        help="JSON file describing the layers (alternative to repeated --layer)",
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
        "--name",
        default=None,
        metavar="TEXT",
        help="Tileset name stored in the archive metadata (default: output file stem)",
    )
    parser.add_argument(
        "--description",
        default=None,
        metavar="TEXT",
        help="Tileset description stored in the archive metadata",
    )
    parser.add_argument(
        "--simplification",
        type=float,
        default=None,
        metavar="N",
        help="Geometry simplification factor applied below the max zoom",
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=None,
        metavar="BYTES",
        help="Maximum tile size; features past it are dropped (GDAL default: 500000)",
    )
    parser.add_argument(
        "--max-features",
        type=int,
        default=None,
        metavar="N",
        help="Maximum features per tile; the rest are dropped (GDAL default: 200000)",
    )
    args = parser.parse_args(argv[1:])

    if not 0 <= args.minzoom <= 22 or not 0 <= args.maxzoom <= 22:
        print("error: --minzoom/--maxzoom must be between 0 and 22", file=sys.stderr)
        return 2
    if args.minzoom > args.maxzoom:
        print("error: --minzoom must be <= --maxzoom", file=sys.stderr)
        return 2
    if args.layer and args.spec:
        print("error: --layer and --spec are mutually exclusive", file=sys.stderr)
        return 2

    creation = {
        "name": args.name,
        "description": args.description,
        "simplification": args.simplification,
        "max_size": args.max_size,
        "max_features": args.max_features,
    }

    # Explicit composition mode: --layer flags or a --spec file.
    if args.layer or args.spec:
        if args.spec:
            spec_path = Path(args.spec)
            if not spec_path.is_absolute():
                spec_path = (Path.cwd() / spec_path).resolve()
            if not spec_path.exists():
                print(f"error: spec not found: {spec_path}", file=sys.stderr)
                return 1
            try:
                sources = load_spec(spec_path)
            except (ValueError, json.JSONDecodeError) as err:
                print(f"error: invalid spec {spec_path}: {err}", file=sys.stderr)
                return 2
        else:
            sources = args.layer

        out_raw = args.output_flag or args.output or args.input
        if not out_raw:
            print(
                "error: an output path is required with --layer/--spec (use -o PATH)",
                file=sys.stderr,
            )
            return 2
        output_path = Path(out_raw)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()

        grouped = group_sources(sources)
        errors = validate_sources(grouped)
        if errors:
            for err in errors:
                print(f"error: {err}", file=sys.stderr)
            return 2

        convert(grouped, output_path, args.minzoom, args.maxzoom, **creation)
        return 0

    # Path mode: a single GeoJSON or a folder of them.
    input_path = Path(args.input if args.input is not None else str(DEFAULT_INPUT))
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 1

    out_raw = args.output_flag or args.output
    if out_raw is not None:
        output_path = Path(out_raw)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    elif input_path.is_dir():
        output_path = input_path / (input_path.name + ".pmtiles")
    else:
        output_path = input_path.with_suffix(".pmtiles")

    # Folder mode: every GeoJSON becomes a layer in one archive.
    if input_path.is_dir():
        return convert_folder(
            input_path, output_path, args.minzoom, args.maxzoom, **creation
        )

    # Single-file mode.
    grouped = group_sources([LayerSource(name=input_path.stem.lower(), path=input_path)])
    convert(grouped, output_path, args.minzoom, args.maxzoom, **creation)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
