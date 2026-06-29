import { useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import { IconLayer } from "@deck.gl/layers";
import {
  DEFAULT_CLICK_MARKER,
  resolveMarkerIconUrl,
  type ClickMarkerConfig,
} from "@/config/map-config";

export interface ClickPoint {
  lng: number;
  lat: number;
}

/**
 * Build the always-on-top "you clicked here" marker as a deck.gl IconLayer.
 * Returns `[]` when there is no marker. Loaded through the `topLayers` channel
 * (pinned above data + labels via `bringStudyareaToTop`), mirroring
 * `useStudyAreaLayer`. Call once per map — Layer instances must not be shared
 * across two Deck overlays.
 *
 * Appearance (`icon`, `size`, `color`) comes from `map.json`'s `clickMarker`
 * block. The icon is a single-color SVG rendered as a mask (`mask: true`), so
 * the on-map color is controlled via `getColor`, not baked into the asset.
 */
export function useClickMarkerLayers(
  point: ClickPoint | null,
  config: ClickMarkerConfig = DEFAULT_CLICK_MARKER,
): Layer[] {
  const { icon, size, color } = config;
  const iconUrl = resolveMarkerIconUrl(icon);
  return useMemo(() => {
    if (!point) return [];

    return [
      new IconLayer<ClickPoint>({
        id: "click-marker",
        data: [point],
        pickable: false,
        getPosition: (d) => [d.lng, d.lat],
        getIcon: () => ({
          id: iconUrl,
          url: iconUrl,
          width: 24,
          height: 24,
          // Anchor at the tip of the pin (bottom-center) so it points at the click.
          anchorX: 12,
          anchorY: 24,
          mask: true,
        }),
        getSize: size,
        sizeUnits: "pixels",
        getColor: color,
        billboard: true,
      }),
    ];
  }, [point, iconUrl, size, color]);
}
