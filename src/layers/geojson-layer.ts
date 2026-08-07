import type { MapRef } from "react-map-gl/maplibre";
import type { AddLayerObject } from "maplibre-gl";
import { anchorForConfig } from "@/components/map/map-view-config";
import { buildNativeLayerDefs } from "./mvt-style";
import type { LayerConfig } from "./types";

/**
 * The in-memory `geojson` format: features pushed in by the host rather than
 * fetched (the Power BI bridge — see `use-embed-data.ts`). Rendered as a plain
 * MapLibre GeoJSON source, so it picks up native styling, picking and hover for
 * free; under deck.gl this was a single `GeoJsonLayer` outside all of that.
 *
 * The area filter deliberately does NOT apply to embed data: the host controls
 * its own dataset and would be surprised to see the app filter it. That is why
 * these layers are built with the rule filter only, not `combinedNativeFilter`.
 */

export function geojsonSourceId(config: LayerConfig): string {
  return `geojson-source-${config.id}`;
}

/**
 * deck's `GeoJsonLayer` drew points, lines and polygons from ONE layer.
 * MapLibre needs one layer per geometry type, so when the config doesn't
 * declare a `geometryType` (it is optional in the bridge payload) all three
 * are emitted — a layer whose geometry is absent simply draws nothing.
 */
function layerDefsFor(config: LayerConfig): AddLayerObject[] {
  const sourceId = geojsonSourceId(config);
  const asSpec = (def: ReturnType<typeof buildNativeLayerDefs>[number]): AddLayerObject => {
    const spec: Record<string, unknown> = {
      id: def.id,
      source: sourceId,
      type: def.type,
      paint: def.paint,
      layout: def.layout,
    };
    if (def.filter) spec.filter = def.filter;
    return spec as unknown as AddLayerObject;
  };

  if (config.geometryType) return buildNativeLayerDefs(config).map(asSpec);

  // Untyped: emit a fill, a line and a circle variant so any geometry shows.
  return (["polygon", "line", "point"] as const).flatMap((geometryType) =>
    buildNativeLayerDefs({ ...config, geometryType }).map((def) =>
      asSpec({ ...def, id: `${def.id}-${geometryType}` }),
    ),
  );
}

/** Add (or refresh) the source and its layers. Idempotent. */
export function addGeoJsonLayer(
  config: LayerConfig,
  mapRef: React.RefObject<MapRef | null>,
) {
  const map = mapRef.current?.getMap();
  if (!map || !config.data) return;

  const sourceId = geojsonSourceId(config);
  const source = map.getSource(sourceId);
  if (source && "setData" in source) {
    (source as { setData: (d: unknown) => void }).setData(config.data);
  } else if (!source) {
    map.addSource(sourceId, { type: "geojson", data: config.data });
  }

  const beforeId = anchorForConfig(config);
  for (const spec of layerDefsFor(config)) {
    if (map.getLayer(spec.id)) continue;
    // addLayer throws on a beforeId that isn't in the style yet.
    map.addLayer(spec, map.getLayer(beforeId) ? beforeId : undefined);
  }
}

/** Remove the source and its layers. Idempotent. */
export function removeGeoJsonLayer(
  config: LayerConfig,
  mapRef: React.RefObject<MapRef | null>,
) {
  const map = mapRef.current?.getMap();
  if (!map) return;
  for (const spec of layerDefsFor(config)) {
    if (map.getLayer(spec.id)) map.removeLayer(spec.id);
  }
  const sourceId = geojsonSourceId(config);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** The layer ids this config renders as — for visibility toggles and picking. */
export function geojsonLayerIds(config: LayerConfig): string[] {
  return layerDefsFor(config).map((spec) => spec.id);
}
