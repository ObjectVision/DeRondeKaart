import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AddLayerObject, Map as MapLibreMap } from "maplibre-gl";
import type { MapViewHandle } from "@/components/map/MapView";
import { loadIconBitmap } from "@/layers/icon-sprite";
import {
  EMPTY_FC,
  featureCollection,
  styleReady,
  syncGeoJsonOverlay,
} from "@/layers/geojson-overlay";
import {
  DEFAULT_CLICK_MARKER,
  resolveMarkerIconUrl,
  type ClickMarkerConfig,
} from "@/config/map-config";

export interface ClickPoint {
  lng: number;
  lat: number;
}

const SOURCE_ID = "click-marker";
const LAYER_ID = "click-marker-symbol";
const IMAGE_ID = "click-marker-icon";

/**
 * Sprite resolution. The icon is drawn at `config.size` (typically 24–32px);
 * rasterizing at 4× and registering with a matching `pixelRatio` keeps it
 * sharp on hi-dpi screens and in the scaled PNG export, while `icon-size`
 * still works against the logical 24px size.
 */
const ICON_SCALE = 4;
const ICON_BASE_PX = 24;

/** rgba() string from the config's [r,g,b,a] tuple (a is 0–255). */
function rgba(color: [number, number, number, number]): string {
  const [r, g, b, a] = color;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function markerLayer(config: ClickMarkerConfig): AddLayerObject {
  return {
    id: LAYER_ID,
    type: "symbol",
    source: SOURCE_ID,
    layout: {
      "icon-image": IMAGE_ID,
      // `size` is a height in screen px, as in the old IconLayer; icon-size is
      // a multiplier on the sprite's logical size.
      "icon-size": config.size / ICON_BASE_PX,
      // Anchor at the tip of the pin so it points at the click, then apply the
      // configured pixel nudge. icon-offset is in the icon's own pixels
      // (pre-icon-size), so scale the nudge to match.
      "icon-anchor": "bottom",
      "icon-offset": [
        (config.offsetX * ICON_BASE_PX) / config.size,
        (config.offsetY * ICON_BASE_PX) / config.size,
      ],
      // Never let collision detection drop the marker — it is a direct
      // response to the user's click and must always appear.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    // Only SDF images honour icon-color; the image is registered as one below.
    paint: { "icon-color": rgba(config.color) },
  } as AddLayerObject;
}

/**
 * Draw the "you clicked here" marker as a MapLibre symbol layer, pinned above
 * everything else. `point` of `null` clears it.
 *
 * Appearance (`icon`, `size`, `color`) comes from `map.json`'s `clickMarker`
 * block. The icon is a single-color SVG registered as an **SDF** sprite image,
 * so the on-map color comes from `icon-color` rather than being baked into the
 * asset — the same trick the config-layer icon path uses (see `iconSpriteId`).
 *
 * Returns a `resync` to re-add the layer after a basemap swap (`setStyle()`
 * wipes both the sprite image and the layer); call it from `onLabelsReady`.
 */
export function useClickMarkerLayers(
  point: ClickPoint | null,
  mapViewRef: React.RefObject<MapViewHandle | null>,
  config: ClickMarkerConfig = DEFAULT_CLICK_MARKER,
): { resync: () => void } {
  // Latest inputs, read by `resync` — which fires from a map event, long after
  // the render that produced them. Written in an effect, never in render.
  const latestRef = useRef({ point, config });
  // Guards against two concurrent rasterizations racing to addImage (which
  // throws on a duplicate id).
  const pendingRef = useRef<Promise<void> | null>(null);

  const ensureImage = useCallback(
    (map: MapLibreMap, icon: string): Promise<void> | null => {
      if (map.hasImage(IMAGE_ID)) return null;
      if (pendingRef.current) return pendingRef.current;

      const url = resolveMarkerIconUrl(icon);
      const work = loadIconBitmap(url, ICON_BASE_PX * ICON_SCALE, ICON_BASE_PX * ICON_SCALE)
        .then((bitmap) => {
          // The style may have been swapped while the image was loading.
          if (map.hasImage(IMAGE_ID)) return;
          map.addImage(IMAGE_ID, bitmap, { sdf: true, pixelRatio: ICON_SCALE });
        })
        .catch((err) => {
          console.error(`Failed to load click marker icon "${url}":`, err);
        })
        .finally(() => {
          pendingRef.current = null;
        });

      pendingRef.current = work;
      return work;
    },
    [],
  );

  const draw = useCallback(
    (current: ClickPoint | null, cfg: ClickMarkerConfig) => {
      const map = mapViewRef.current?.mapRef.current?.getMap();
      if (!styleReady(map)) return;

      const paint = () => {
        if (!styleReady(map) || !map.hasImage(IMAGE_ID)) return;
        const data = current
          ? featureCollection({
              type: "Feature" as const,
              properties: {},
              geometry: { type: "Point" as const, coordinates: [current.lng, current.lat] },
            })
          : EMPTY_FC;
        syncGeoJsonOverlay(map, SOURCE_ID, [markerLayer(cfg)], data);
      };

      // The image must be in the sprite before addLayer, and loading it is async.
      const pending = ensureImage(map, cfg.icon);
      if (pending) {
        void pending.then(paint);
        return;
      }
      paint();
    },
    [mapViewRef, ensureImage],
  );

  useEffect(() => {
    latestRef.current = { point, config };
    draw(point, config);
  }, [point, config, draw]);

  const resync = useCallback(() => {
    const { point: p, config: c } = latestRef.current;
    draw(p, c);
  }, [draw]);
  return useMemo(() => ({ resync }), [resync]);
}
