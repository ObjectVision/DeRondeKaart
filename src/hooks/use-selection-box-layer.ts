import { useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import { PolygonLayer } from "@deck.gl/layers";
import type { BBox } from "@/layers/box-filter";

/**
 * Build the area-select rectangle as a deck.gl PolygonLayer. Returns `[]`
 * when there is no box. Loaded through the `topLayers` channel (pinned above
 * data + labels), mirroring `useClickMarkerLayers`. Call once per map —
 * Layer instances must not be shared across two Deck overlays.
 */
export function useSelectionBoxLayers(box: BBox | null, suffix: string): Layer[] {
  return useMemo(() => {
    if (!box) return [];
    const [minLng, minLat, maxLng, maxLat] = box;
    return [
      new PolygonLayer<BBox>({
        id: `selection-box-${suffix}`,
        data: [box],
        pickable: false,
        filled: true,
        stroked: true,
        getPolygon: () => [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
        ],
        // Brand blue #00498D: faint tint inside, solid 2px outline.
        getFillColor: [0, 73, 141, 15],
        getLineColor: [0, 73, 141, 220],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
      }),
    ];
  }, [box, suffix]);
}
