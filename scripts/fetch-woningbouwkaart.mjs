// Build the Nationale Woningbouwkaart layer data for data.woonzorglimburg.nl.
//
// The source (nationalewoningbouwkaart.nl, BZK / Landelijke Monitor Voortgang
// Woningbouw) serves two static files and NO CORS headers, so the browser
// cannot fetch them directly — re-hosting is what makes the layer possible at
// all, not an optimisation. This script is the publish step.
//
// It also converts the polygons from TopoJSON, which MapLibre has no source
// type for. Doing that here rather than in the app keeps `topojson-client` out
// of the bundle entirely; it is a devDependency.
//
// Rerun when the LMVW refreshes (twice a year: Voorjaar / Najaar). Any HTTP
// failure aborts loudly: the upstream filename already carries a "2" suffix
// (project2.json.gz), so these paths can move without notice, and a silent
// empty file would surface as a layer that draws nothing.
//
//   node scripts/fetch-woningbouwkaart.mjs [outDir]
//
// Then upload:
//   scp <outDir>/*.geojson cicada@37.97.169.242:/var/www/woonzorglimburg_data/geojson/

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { feature } from "topojson-client";

const BASE = "https://nationalewoningbouwkaart.nl";
const POINTS = "/project2.json.gz";
const SHAPES = "/project_shape_topo.json.gz";

/** Only this province is published; the app is a Limburg viewer. */
const PROVINCE = "Limburg";

/** Fetch one gzipped JSON file and parse it. */
async function fetchGzJson(urlPath) {
  const url = `${BASE}${urlPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);

  const raw = Buffer.from(await res.arrayBuffer());
  // Served as application/octet-stream, so fetch does not decompress it for us.
  // Tolerate a host that starts sending Content-Encoding: gzip, which would.
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(raw) : raw).toString("utf8");
  return { json: JSON.parse(text), bytes: raw.length };
}

function writeCollection(outDir, name, features) {
  const file = path.join(outDir, name);
  const body = JSON.stringify({ type: "FeatureCollection", features });
  fs.writeFileSync(file, body);
  const gz = zlib.gzipSync(body).length;
  console.log(
    `  ${name}: ${features.length} features, ` +
      `${(body.length / 1048576).toFixed(2)}MB raw, ${(gz / 1048576).toFixed(2)}MB gzipped`,
  );
}

async function main() {
  const outDir = path.resolve(process.argv[2] ?? "dist-woningbouwkaart");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Fetching from ${BASE} ...`);
  const [pointsFile, shapesFile] = await Promise.all([
    fetchGzJson(POINTS),
    fetchGzJson(SHAPES),
  ]);

  const allPoints = pointsFile.json.features;
  const points = allPoints.filter((f) => f.properties?.provincie_naam === PROVINCE);
  if (points.length === 0) {
    // The province name is a plain string in the source data; if it is ever
    // spelled differently this filter would silently publish nothing.
    throw new Error(`no features with provincie_naam === ${JSON.stringify(PROVINCE)}`);
  }

  // The topology carries no `transform`, so coordinates are already absolute
  // and no dequantization step is needed.
  const shapesAll = feature(shapesFile.json, shapesFile.json.objects.data).features;

  // The two files pair on project_id. Filtering shapes by the point ids keeps
  // the sets consistent even if one file is refreshed before the other.
  const keep = new Set(points.map((f) => f.properties.project_id));
  const shapes = shapesAll.filter((f) => keep.has(f.properties?.project_id));

  console.log(`\n${PROVINCE}: ${points.length} of ${allPoints.length} projects`);
  writeCollection(outDir, "woningbouw-punten.geojson", points);
  writeCollection(outDir, "woningbouw-vlakken.geojson", shapes);

  if (shapes.length !== points.length) {
    // Not fatal — a plan without a drawn area is legitimate — but worth seeing,
    // because a large gap means the two files are out of step.
    console.warn(
      `\nNote: ${points.length - shapes.length} project(s) have no polygon; ` +
        "their dot still renders.",
    );
  }

  const status = new Map();
  for (const f of points) {
    const s = f.properties.Planstatus ?? "(onbekend)";
    status.set(s, (status.get(s) ?? 0) + 1);
  }
  console.log(
    "\nPlanstatus:",
    [...status].map(([k, v]) => `${k}=${v}`).join(", "),
    "| peilmoment:",
    [...new Set(points.map((f) => f.properties.peilmoment))].join(", "),
  );
  console.log(`\nWritten to ${outDir}`);
  console.log(
    "Upload: scp " +
      path.join(outDir, "*.geojson") +
      " cicada@37.97.169.242:/var/www/woonzorglimburg_data/geojson/",
  );
}

main().catch((err) => {
  console.error(`fetch-woningbouwkaart: ${err.message}`);
  process.exit(1);
});
