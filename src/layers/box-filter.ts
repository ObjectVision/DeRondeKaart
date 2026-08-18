/**
 * Box filter: a user-drawn selection rectangle (area select tool) shared as a
 * module-level store, mirroring the area-filter pattern. It restricts ONLY the
 * charts/statistics aggregation — map rendering and picking are unaffected.
 *
 * A row passes when its geometry's representative point (point coordinate, or
 * first vertex for lines/polygons) lies inside the box. Tables without a
 * recognized geoarrow geometry column pass unfiltered, matching how the area
 * filter skips inapplicable levels.
 *
 * Both geoarrow encodings the parquet sources use are handled: nested
 * coordinate lists, and `geoarrow.wkb` (the chart sidecars). WKB used to fall
 * through the "unrecognized" case, which silently passed every row — the box
 * tool looked armed but changed no numbers.
 */
import { createSignal } from "solid-js";
import type { Table } from "apache-arrow";
import type { MultiPolygon, Polygon } from "geojson";

/** Selection rectangle as [minLng, minLat, maxLng, maxLat]. */
export type BBox = [number, number, number, number];

/**
 * The store is a signal rather than a plain object plus a version counter.
 *
 * The counter existed only to give React a scalar it could hold in state as a
 * cache key — the store was the real source of truth and React could not
 * observe it. A signal *is* observable, so every reader (chart aggregation,
 * the map expressions, the legend) re-runs on its own when the box changes,
 * and callers no longer have to thread a version through their state.
 */
const [boxFilter, setBoxFilterSignal] = createSignal<BBox | null>(null);

/**
 * The active selection rectangle, or null when the tool has not drawn one.
 * Reading this inside a memo or effect subscribes that computation to it.
 */
export { boxFilter };

/** Replace the active box, or clear it with null. */
export function setBoxFilter(bbox: BBox | null): void {
  setBoxFilterSignal(() => bbox);
}

// ---------------------------------------------------------------------------
// Geometry column resolution, memoized per Table.
// ---------------------------------------------------------------------------

/** List-nesting levels above the coordinate for each geoarrow encoding. */
const GEOMETRY_DEPTHS: Record<string, number> = {
  "geoarrow.point": 0,
  "geoarrow.multipoint": 1,
  "geoarrow.linestring": 1,
  "geoarrow.polygon": 2,
  "geoarrow.multilinestring": 2,
  "geoarrow.multipolygon": 3,
};

/**
 * A geometry column, in one of the two encodings the parquet sources use:
 * nested coordinate lists (`depth` list levels above the coordinate), or
 * `geoarrow.wkb` — an opaque binary blob per row that has to be parsed.
 */
type ResolvedGeometry =
  | { col: { get(index: number): unknown }; kind: "nested"; depth: number }
  | { col: { get(index: number): unknown }; kind: "wkb" };

const geometryCache = new WeakMap<Table, ResolvedGeometry | null>();

function resolveGeometry(table: Table): ResolvedGeometry | null {
  const cached = geometryCache.get(table);
  if (cached !== undefined) return cached;

  let resolved: ResolvedGeometry | null = null;
  for (const field of table.schema.fields) {
    const extension = field.metadata.get("ARROW:extension:name");
    if (!extension) continue;
    const col = table.getChild(field.name);
    if (!col) continue;
    if (extension === "geoarrow.wkb") {
      resolved = { col, kind: "wkb" };
      break;
    }
    const depth = GEOMETRY_DEPTHS[extension];
    if (depth === undefined) continue;
    resolved = { col, kind: "nested", depth };
    break;
  }
  geometryCache.set(table, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// WKB (well-known binary), as written by the chart sidecar parquet files.
// ---------------------------------------------------------------------------

/** WKB geometry type codes (the 2D subset these sources use). */
const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;

/**
 * First coordinate of a WKB geometry — the same "representative point" the
 * nested path takes (point coordinate, or first vertex for lines/polygons), so
 * WKB and non-WKB layers filter identically.
 *
 * Only the header is walked, never the full coordinate list: a Limburg-wide
 * polygon can carry thousands of vertices and the box test needs exactly one.
 *
 * Layout (all counts uint32, coordinates float64, endianness per the leading
 * byte — WKB permits either, and nested geometries re-declare their own):
 *
 *   Point           order type            coord      -> 5
 *   LineString      order type nPts       coord      -> 9
 *   Polygon         order type nRings nPts coord     -> 13
 *   Multi*          order type nParts <nested geom>  -> recurse at 9
 */
function wkbFirstCoord(bytes: Uint8Array, depth = 0): [number, number] | null {
  // Guard against a cycle from a malformed blob; real nesting is 1 level.
  if (depth > 4 || bytes.byteLength < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = view.getUint8(0) === 1;
  const type = view.getUint32(1, littleEndian);

  let offset: number;
  switch (type) {
    case WKB_POINT:
      offset = 5;
      break;
    case WKB_LINESTRING:
    case WKB_MULTIPOINT:
      offset = 9;
      break;
    case WKB_POLYGON:
      offset = 13;
      break;
    case WKB_MULTILINESTRING:
    case WKB_MULTIPOLYGON:
      // The first part is a complete WKB geometry with its own byte-order byte.
      return wkbFirstCoord(bytes.subarray(9), depth + 1);
    default:
      // Unknown/3D type: excluding the row beats inventing a coordinate.
      return null;
  }

  if (offset + 16 > bytes.byteLength) return null;
  const x = view.getFloat64(offset, littleEndian);
  const y = view.getFloat64(offset + 8, littleEndian);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Row value as raw WKB bytes, or null when the column holds something else. */
function wkbBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

/**
 * Drill down `depth` list levels (first part / ring / vertex) to the
 * coordinate, then read x/y. Coordinates surface differently depending on the
 * arrow layout: a FixedSizeList Vector (`.get`), a plain/typed array, or a
 * struct row with `.x`/`.y` for separated coords.
 */
function representativeCoord(value: unknown, depth: number): [number, number] | null {
  let v = value as { get?: (i: number) => unknown; x?: unknown; y?: unknown } | null;
  for (let d = 0; d < depth; d++) {
    if (v === null || v === undefined) return null;
    v = (typeof v.get === "function" ? v.get(0) : (v as unknown as unknown[])[0]) as typeof v;
  }
  if (v === null || v === undefined) return null;
  let x: unknown;
  let y: unknown;
  if (typeof v.get === "function") {
    x = v.get(0);
    y = v.get(1);
  } else if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    x = (v as unknown as unknown[])[0];
    y = (v as unknown as unknown[])[1];
  } else {
    x = v.x;
    y = v.y;
  }
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y]
    : null;
}

/** Read one coordinate (any of the three arrow layouts) into the callback. */
function readCoord(v: unknown, cb: (x: number, y: number) => void): void {
  if (v === null || v === undefined) return;
  const c = v as { get?: (i: number) => unknown; x?: unknown; y?: unknown };
  let x: unknown;
  let y: unknown;
  if (typeof c.get === "function") {
    x = c.get(0);
    y = c.get(1);
  } else if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    x = (v as unknown[])[0];
    y = (v as unknown[])[1];
  } else {
    x = c.x;
    y = c.y;
  }
  if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
    cb(x, y);
  }
}

/** Walk every coordinate `depth` list levels below `value`. */
function walkCoords(value: unknown, depth: number, cb: (x: number, y: number) => void): void {
  if (value === null || value === undefined) return;
  if (depth === 0) {
    readCoord(value, cb);
    return;
  }
  const list = value as { get?: (i: number) => unknown; length?: number };
  const length = typeof list.length === "number" ? list.length : 0;
  for (let i = 0; i < length; i++) {
    const child = typeof list.get === "function" ? list.get(i) : (value as unknown[])[i];
    walkCoords(child, depth - 1, cb);
  }
}

// ---------------------------------------------------------------------------
// Row geometry -> GeoJSON (used by the filtered study area overlay).
// ---------------------------------------------------------------------------

type Position = [number, number];

/** Convert `depth` nested list levels below `value` into coordinate arrays. */
function nestedCoords(value: unknown, depth: number): unknown[] {
  if (depth === 0) {
    let coord: Position | null = null;
    readCoord(value, (x, y) => {
      coord = [x, y];
    });
    return coord ? [coord] : [];
  }
  const list = value as { get?: (i: number) => unknown; length?: number };
  const length = typeof list.length === "number" ? list.length : 0;
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const child = typeof list.get === "function" ? list.get(i) : (value as unknown[])[i];
    if (depth === 1) {
      // A ring / linestring: collect its coordinates flat.
      readCoord(child, (x, y) => out.push([x, y]));
    } else {
      out.push(nestedCoords(child, depth - 1));
    }
  }
  return out;
}

/**
 * Read the row's geoarrow geometry as a GeoJSON Polygon or MultiPolygon
 * (`null` for rows without a recognized polygonal geometry). Coordinates are
 * copied out of the arrow buffers, so the result is independent of the table.
 */
export function rowGeometryToGeoJson(
  table: Table,
  index: number,
): Polygon | MultiPolygon | null {
  const geometry = resolveGeometry(table);
  // WKB is decoded only far enough for the box test's representative point, not
  // into full rings. No caller needs it: the study-area overlay reads the
  // filter.json sources, which are all natively encoded.
  if (!geometry || geometry.kind === "wkb") return null;
  const value = geometry.col.get(index);
  if (value === null || value === undefined) return null;
  if (geometry.depth === 2) {
    return { type: "Polygon", coordinates: nestedCoords(value, 2) as Position[][] };
  }
  if (geometry.depth === 3) {
    return { type: "MultiPolygon", coordinates: nestedCoords(value, 3) as Position[][][] };
  }
  return null; // point/line encodings aren't study areas
}

/**
 * Extend `into` ([minLng, minLat, maxLng, maxLat]) with EVERY coordinate of
 * the row's geometry (used by the filter fly-to to frame selected areas).
 * Returns whether any coordinate was read. Rows without a recognized
 * geometry column contribute nothing.
 */
export function extendRowBbox(table: Table, index: number, into: BBox): boolean {
  const geometry = resolveGeometry(table);
  // WKB: see rowGeometryToGeoJson — the fly-to callers read natively-encoded
  // filter sources, so walking every WKB vertex would be dead code.
  if (!geometry || geometry.kind === "wkb") return false;
  let any = false;
  walkCoords(geometry.col.get(index), geometry.depth, (x, y) => {
    into[0] = Math.min(into[0], x);
    into[1] = Math.min(into[1], y);
    into[2] = Math.max(into[2], x);
    into[3] = Math.max(into[3], y);
    any = true;
  });
  return any;
}

/**
 * Whether the table row's representative point lies inside the active box.
 * No box or no recognized geometry column passes everything; a present but
 * unreadable geometry fails the row (it cannot be located).
 */
export function arrowRowMatchesBoxFilter(table: Table, index: number): boolean {
  const bbox = boxFilter();
  if (!bbox) return true;
  const geometry = resolveGeometry(table);
  if (!geometry) return true;
  const value = geometry.col.get(index);
  const coord =
    geometry.kind === "wkb"
      ? (() => {
          const bytes = wkbBytes(value);
          return bytes ? wkbFirstCoord(bytes) : null;
        })()
      : representativeCoord(value, geometry.depth);
  if (!coord) return false;
  const [lng, lat] = coord;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
