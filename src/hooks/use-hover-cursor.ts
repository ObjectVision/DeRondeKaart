import { useCallback, useMemo } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "./use-map-layers";
import { buildNativeLayerDefs, expandForMapQueries, isNativeVectorFormat, canHighlight } from "@/layers";
import { geojsonLayerIds } from "@/layers/geojson-layer";
import type { LayerConfig } from "@/layers";

/**
 * Drives the map cursor to `pointer` over clickable features (layers with
 * `featureinfo` and not excluded from picking).
 *
 * The cursor is written straight onto the canvas: a cheap
 * `queryRenderedFeatures` per mousemove decides, and clearing it back to `""`
 * (NOT "grab") hands control to MapLibre's own stylesheet, which is what draws
 * grab/grabbing during a drag-pan. Writing "grab" explicitly would freeze the
 * cursor and break `grabbing`.
 *
 * A crosshair while a draw tool is armed outranks this and is applied by App;
 * `drawModeRef` is checked here so a hover never overwrites it.
 */
export interface UseHoverCursorResult {
  handleMouseMove: (event: MapLayerMouseEvent) => void;
}

export function useHoverCursor(
  layerEntries: LayerEntry[],
  mapViewRef: React.RefObject<MapViewHandle | null>,
  /**
   * Called with the highlightable feature under the pointer, or (null, null)
   * when there is none. Optional: the cursor works without a highlight driver.
   */
  onHover?: (config: LayerConfig | null, featureId: string | number | null) => void,
): UseHoverCursorResult {
  // Highlightable layers, independent of whether they answer clicks.
  const highlightEntries = useMemo(
    () => expandForMapQueries(layerEntries).filter((e) => canHighlight(e.config)),
    [layerEntries],
  );

  // Clickable set: same filter as use-feature-pick.ts. Composite entries are
  // expanded to their children (the configs actually on the map), with the
  // parent's featureinfo/excludeFromPicking deciding clickability.
  const clickableEntries = useMemo(
    () =>
      expandForMapQueries(layerEntries).filter(
        (e) =>
          e.featureinfo &&
          e.config.format !== "cog" &&
          !e.excludeFromPicking,
      ),
    [layerEntries],
  );

  const handleMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const handle = mapViewRef.current;
      const map = handle?.mapRef?.current?.getMap();
      if (!map) return;

      // An armed draw tool owns the cursor; don't fight it.
      if (handle?.drawModeRef.current) return;

      const canvas = map.getCanvas();
      const layerIds: string[] = [];
      for (const entry of clickableEntries) {
        if (isNativeVectorFormat(entry.config.format)) {
          for (const def of buildNativeLayerDefs(entry.config)) {
            if (map.getLayer(def.id)) layerIds.push(def.id);
          }
        } else if (entry.config.format === "geojson") {
          for (const id of geojsonLayerIds(entry.config)) {
            if (map.getLayer(id)) layerIds.push(id);
          }
        }
      }

      // Highlightable layers are hovered even when they answer no click: the
      // two flags are independent, and an outline that only appeared on
      // clickable layers would look arbitrary.
      const highlightIds: string[] = [];
      for (const entry of highlightEntries) {
        for (const def of buildNativeLayerDefs(entry.config)) {
          if (map.getLayer(def.id)) highlightIds.push(def.id);
        }
      }

      if (layerIds.length === 0 && highlightIds.length === 0) {
        canvas.style.cursor = "";
        onHover?.(null, null);
        return;
      }

      // One query covering both sets, then split by which layer answered — the
      // cursor must only respond to clickable layers.
      const queryIds = [...new Set([...layerIds, ...highlightIds])];
      const features = map.queryRenderedFeatures(event.point, { layers: queryIds });

      const clickable = new Set(layerIds);
      canvas.style.cursor = features.some((f) => clickable.has(f.layer.id)) ? "pointer" : "";

      if (onHover) {
        const hit = features.find((f) => highlightIds.includes(f.layer.id));
        const config = hit
          ? highlightEntries.find((e) =>
              buildNativeLayerDefs(e.config).some((d) => d.id === hit.layer.id),
            )?.config ?? null
          : null;
        onHover(config, hit?.id ?? null);
      }
    },
    [clickableEntries, highlightEntries, mapViewRef, onHover],
  );

  return { handleMouseMove };
}
