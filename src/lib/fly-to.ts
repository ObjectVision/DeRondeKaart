import type { BBox } from "@/layers/box-filter";

/**
 * The app's single fly-to system.
 *
 * - `viewForBbox` is THE bbox → center/zoom heuristic. The Power BI visual
 *   used to carry its own copy; it now posts `view: { bbox }` and the app
 *   resolves it here (use-url-commands → App.applyView).
 * - `flyToView` dispatches the shared `map:flyto` CustomEvent that every
 *   MapView instance listens to (also used by the location search) for an
 *   animated MapLibre flyTo.
 */

/** Compute a center + zoom that frames the bbox ([minLng, minLat, maxLng, maxLat]). */
export function viewForBbox(bbox: BBox): { center: [number, number]; zoom: number } {
  const center: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  // Latitude extent counts double (viewports are wider than tall); the floor
  // keeps the whole extent in view, clamped to a sane zoom range.
  const extent = Math.max(bbox[2] - bbox[0], (bbox[3] - bbox[1]) * 2, 0.005);
  const zoom = Math.max(5, Math.min(15, Math.floor(Math.log2(360 / extent))));
  return { center, zoom };
}

/** Animated fly-to on every mounted map via the shared `map:flyto` event. */
export function flyToView(center: [number, number], zoom?: number): void {
  window.dispatchEvent(
    new CustomEvent("map:flyto", {
      detail: { longitude: center[0], latitude: center[1], zoom },
    }),
  );
}

/** Fly to the view framing a bbox. */
export function flyToBbox(bbox: BBox): void {
  const view = viewForBbox(bbox);
  flyToView(view.center, view.zoom);
}
