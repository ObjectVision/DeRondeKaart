/**
 * Box filter: a user-drawn selection rectangle (area select tool) shared as a
 * module-level store, mirroring the area-filter pattern. It restricts ONLY the
 * charts/statistics aggregation — map rendering and picking are unaffected.
 *
 * A row passes when its geometry's representative point (point coordinate, or
 * first vertex for lines/polygons) lies inside the box. Tables without a
 * recognized geoarrow geometry column pass unfiltered, matching how the area
 * filter skips inapplicable levels.
 */
import type { Table } from "apache-arrow";

/** Selection rectangle as [minLng, minLat, maxLng, maxLat]. */
export type BBox = [number, number, number, number];

const store: { bbox: BBox | null; version: number } = { bbox: null, version: 0 };

/**
 * Replace the active box (or clear it with null). Returns the new store
 * version (used as chart-data cache key component).
 */
export function setBoxFilter(bbox: BBox | null): number {
  store.bbox = bbox;
  store.version += 1;
  return store.version;
}

export function getBoxFilterVersion(): number {
  return store.version;
}

export function isBoxFilterActive(): boolean {
  return store.bbox !== null;
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

interface ResolvedGeometry {
  col: { get(index: number): unknown };
  depth: number;
}

const geometryCache = new WeakMap<Table, ResolvedGeometry | null>();

function resolveGeometry(table: Table): ResolvedGeometry | null {
  const cached = geometryCache.get(table);
  if (cached !== undefined) return cached;

  let resolved: ResolvedGeometry | null = null;
  for (const field of table.schema.fields) {
    const extension = field.metadata.get("ARROW:extension:name");
    if (!extension) continue;
    const depth = GEOMETRY_DEPTHS[extension];
    if (depth === undefined) continue;
    const col = table.getChild(field.name);
    if (col) {
      resolved = { col, depth };
      break;
    }
  }
  geometryCache.set(table, resolved);
  return resolved;
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

/**
 * Whether the table row's representative point lies inside the active box.
 * No box or no recognized geometry column passes everything; a present but
 * unreadable geometry fails the row (it cannot be located).
 */
export function arrowRowMatchesBoxFilter(table: Table, index: number): boolean {
  const bbox = store.bbox;
  if (!bbox) return true;
  const geometry = resolveGeometry(table);
  if (!geometry) return true;
  const coord = representativeCoord(geometry.col.get(index), geometry.depth);
  if (!coord) return false;
  const [lng, lat] = coord;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}
