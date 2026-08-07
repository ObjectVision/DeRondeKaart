/** Mean Earth radius in meters (spherical approximation). */
const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle (haversine) distance in meters between two lng/lat points.
 * Plenty accurate at annotation-circle scale; avoids a geodesy dependency.
 */
export function distanceMeters(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Meters per degree of latitude (spherical approximation). */
export const METERS_PER_DEGREE_LAT = 111320;

/** Web-mercator ground resolution in meters per pixel at a latitude + zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos(lat * (Math.PI / 180))) / 2 ** zoom;
}

/**
 * Great-circle destination point from (lng, lat) along a bearing (radians).
 * Spherical model, matching {@link distanceMeters}.
 */
export function destination(
  lng: number,
  lat: number,
  bearingRad: number,
  distanceM: number,
): [number, number] {
  const δ = distanceM / EARTH_RADIUS_M;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
}

/**
 * Closed ring approximating a circle of `radiusM` around a center.
 *
 * MapLibre has no meters-radius circle primitive (`circle-radius` is pixels),
 * so a ground-truth circle has to be emitted as a polygon. 96 segments holds
 * up to roughly a 2000px on-screen diameter without visible faceting; the
 * count is deliberately NOT zoom-adaptive, since that would force the ring to
 * be regenerated on every map move.
 */
export function geodesicRing(
  center: { lng: number; lat: number },
  radiusM: number,
  segments = 96,
): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    ring.push(destination(center.lng, center.lat, (2 * Math.PI * i) / segments, radiusM));
  }
  return ring;
}

/**
 * Vertex-average centroid of a polygon ring — the anchor for its label/popup,
 * not an exact area centroid (fine at annotation scale).
 */
export function centroid(points: Array<{ lng: number; lat: number }>): {
  lng: number;
  lat: number;
} {
  let lng = 0;
  let lat = 0;
  for (const p of points) {
    lng += p.lng;
    lat += p.lat;
  }
  return { lng: lng / points.length, lat: lat / points.length };
}

/**
 * Closest point to `p` on the segment a–b. Planar approximation with
 * longitude scaled by cos(latitude) — used to snap an edge-split click onto
 * the edge, so short segments at annotation scale are plenty accurate.
 */
export function nearestPointOnSegment(
  p: { lng: number; lat: number },
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): { lng: number; lat: number } {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const ax = a.lng * k;
  const bx = b.lng * k;
  const px = p.lng * k;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / len2));
  return { lng: (ax + t * dx) / k, lat: a.lat + t * dy };
}
