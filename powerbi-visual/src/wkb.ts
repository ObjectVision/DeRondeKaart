"use strict";

import type { Geometry, Position } from "geojson";

/**
 * Decode a base64-encoded WKB string (as produced by Power Query's
 * `Binary.ToText` on a geoparquet geometry column) into a GeoJSON Geometry.
 *
 * Supports ISO WKB (Z/M/ZM via type offsets 1000/2000/3000) and EWKB
 * (Z/M/SRID flag bits); Z/M ordinates are read and dropped — output is 2D.
 * Returns null on any malformed input instead of throwing.
 */
export function parseWkbBase64(text: string): Geometry | null {
  const bytes = base64ToBytes(text);
  if (!bytes) return null;
  try {
    const reader = new WkbReader(bytes);
    return reader.readGeometry();
  } catch {
    return null;
  }
}

function base64ToBytes(text: string): Uint8Array | null {
  const cleaned = text.replace(/\s+/g, "");
  if (cleaned.length === 0) return null;
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// EWKB flag bits (PostGIS extended WKB).
const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

class WkbReader {
  private readonly view: DataView;
  private offset = 0;
  private littleEndian = true;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Read one geometry (byte order + type header + body). Throws on malformed data. */
  readGeometry(): Geometry {
    this.littleEndian = this.readUint8() === 1;

    let type = this.readUint32();
    let hasZ = false;
    let hasM = false;

    if (type & EWKB_SRID) {
      this.readUint32(); // skip SRID
    }
    if (type & EWKB_Z) hasZ = true;
    if (type & EWKB_M) hasM = true;
    type &= 0x0fffffff;

    // ISO WKB encodes dimensions as type offsets: 1000 = Z, 2000 = M, 3000 = ZM.
    if (type >= 3000) {
      hasZ = true;
      hasM = true;
      type -= 3000;
    } else if (type >= 2000) {
      hasM = true;
      type -= 2000;
    } else if (type >= 1000) {
      hasZ = true;
      type -= 1000;
    }

    const extraDims = (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    switch (type) {
      case 1:
        return { type: "Point", coordinates: this.readPosition(extraDims) };
      case 2:
        return { type: "LineString", coordinates: this.readPositions(extraDims) };
      case 3:
        return { type: "Polygon", coordinates: this.readRings(extraDims) };
      case 4:
        return { type: "MultiPoint", coordinates: this.readSubGeometries("Point") };
      case 5:
        return { type: "MultiLineString", coordinates: this.readSubGeometries("LineString") };
      case 6:
        return { type: "MultiPolygon", coordinates: this.readSubGeometries("Polygon") };
      case 7: {
        const count = this.readUint32();
        const geometries: Geometry[] = [];
        for (let i = 0; i < count; i++) geometries.push(this.readGeometry());
        return { type: "GeometryCollection", geometries };
      }
      default:
        throw new Error(`unsupported WKB geometry type ${type}`);
    }
  }

  /** Read the member geometries of a Multi* and collect their coordinates. */
  private readSubGeometries<T>(expected: "Point" | "LineString" | "Polygon"): T[] {
    const count = this.readUint32();
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
      const geom = this.readGeometry();
      if (geom.type !== expected) {
        throw new Error(`expected ${expected} inside Multi${expected}, got ${geom.type}`);
      }
      out.push((geom as unknown as { coordinates: T }).coordinates);
    }
    return out;
  }

  private readRings(extraDims: number): Position[][] {
    const count = this.readUint32();
    const rings: Position[][] = [];
    for (let i = 0; i < count; i++) rings.push(this.readPositions(extraDims));
    return rings;
  }

  private readPositions(extraDims: number): Position[] {
    const count = this.readUint32();
    const positions: Position[] = [];
    for (let i = 0; i < count; i++) positions.push(this.readPosition(extraDims));
    return positions;
  }

  private readPosition(extraDims: number): Position {
    const x = this.readFloat64();
    const y = this.readFloat64();
    for (let i = 0; i < extraDims; i++) this.readFloat64(); // drop Z/M
    return [x, y];
  }

  private readUint8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  private readUint32(): number {
    const v = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return v;
  }

  private readFloat64(): number {
    const v = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += 8;
    return v;
  }
}
