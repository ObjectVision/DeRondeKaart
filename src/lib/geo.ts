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
