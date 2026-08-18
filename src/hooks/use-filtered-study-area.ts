import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AddLayerObject } from "maplibre-gl";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { loadParquetBatches } from "@/layers";
import { extendRowBbox, rowGeometryToGeoJson, type BBox } from "@/layers/box-filter";
import type { AreaFilterState } from "@/hooks/use-area-filter";
import { geodesicRing } from "@/lib/geo";
import type { MapViewHandle } from "@/components/map/map-view-config";
import { styleReady, syncGeoJsonOverlay } from "@/layers/geojson-overlay";

/**
 * The gebiedsfilter-driven replacement for the fixed study area: while a
 * gebied is selected, the map shows a 200 km "outside" mask disc around it
 * plus the gebied's own outline, instead of the configured studyarea layer.
 */
export interface FilteredStudyArea {
  /** 200 km disc around the gebied centroid, with the gebied punched out. */
  buffer: Feature<Polygon>;
  /** The selected gebied geometry (one feature per matching table row). */
  area: Feature<Polygon | MultiPolygon>[];
}

const BUFFER_RADIUS_M = 200_000;
/** Coarser than the annotation default: this disc is 200 km across. */
const CIRCLE_SEGMENTS = 64;

/** Closed ring approximating a circle of `radiusM` around a center. */
function circleRing(centerLng: number, centerLat: number, radiusM: number): Position[] {
  return geodesicRing({ lng: centerLng, lat: centerLat }, radiusM, CIRCLE_SEGMENTS);
}

/** The outer ring of every polygon part, used to punch the gebied out of the disc. */
function outerRings(geometry: Polygon | MultiPolygon): Position[][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((part) => part[0]);
}

/**
 * Build the {@link FilteredStudyArea} for the FINEST gebiedsfilter level with
 * a selection, or `null` when nothing is selected (the caller then falls back
 * to the configured studyarea layers). The geometry comes from the filter's
 * own parquet table, already cached by the option loading.
 */
export function useFilteredStudyArea(
  areaFilter: AreaFilterState,
): Accessor<FilteredStudyArea | null> {
  // Finest level with a selection wins (same walk as the filter fly-to). The
  // token identifies the selection, so a stale async result is never returned.
  const finest = createMemo(() => {
    const entries = areaFilter.entries();
    const selections = areaFilter.selections();
    for (let i = entries.length - 1; i >= 0; i--) {
      const codes = selections.get(entries[i].key);
      if (codes && codes.size > 0) {
        return {
          entry: entries[i],
          codes,
          token: `${entries[i].key}:${[...codes].sort().join(",")}`,
        };
      }
    }
    return null;
  });

  const [result, setResult] = createSignal<{ token: string; data: FilteredStudyArea } | null>(
    null,
  );

  createEffect(() => {
    const current = finest();
    if (!current) return; // nothing selected — the token gate below yields null
    let cancelled = false;
    const { entry, codes, token } = current;
    (async () => {
      try {
        // Cached by loadParquetBatches — no refetch after the options load.
        const table = await loadParquetBatches(entry.source, () => {});
        const codeCol = table.getChild(entry.key);
        if (!codeCol) return;

        const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
        const area: Feature<Polygon | MultiPolygon>[] = [];
        for (let row = 0; row < codeCol.length; row++) {
          const raw = codeCol.get(row);
          if (raw === null || raw === undefined || !codes.has(String(raw))) continue;
          extendRowBbox(table, row, bbox);
          const geometry = rowGeometryToGeoJson(table, row);
          if (geometry) area.push({ type: "Feature", geometry, properties: {} });
        }
        if (area.length === 0 || !Number.isFinite(bbox[0])) return;

        // 200 km disc around the bbox center, gebied punched out as holes.
        const centerLng = (bbox[0] + bbox[2]) / 2;
        const centerLat = (bbox[1] + bbox[3]) / 2;
        const holes = area.flatMap((f) => outerRings(f.geometry));
        const buffer: Feature<Polygon> = {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [circleRing(centerLng, centerLat, BUFFER_RADIUS_M), ...holes],
          },
          properties: {},
        };
        if (!cancelled) setResult({ token, data: { buffer, area } });
      } catch (err) {
        console.warn(`Filtered study area failed for "${entry.name}":`, err);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Only hand out data matching the CURRENT selection: no selection or a
  // still-loading one falls back to the configured studyarea (null).
  const data = createMemo(() => {
    const current = finest();
    const loaded = result();
    return current && loaded && loaded.token === current.token ? loaded.data : null;
  });
  return data;
}

const BUFFER_SOURCE_ID = "filtered-study-buffer";
const BUFFER_LAYER_ID = "filtered-study-buffer-fill";
const AREA_SOURCE_ID = "filtered-study-area";
const AREA_LAYER_ID = "filtered-study-area-line";

/** Outside mask: #EBECF0 @ 0.5, no outline. */
const BUFFER_LAYERS: AddLayerObject[] = [
  {
    id: BUFFER_LAYER_ID,
    type: "fill",
    source: BUFFER_SOURCE_ID,
    paint: { "fill-color": "#EBECF0", "fill-opacity": 128 / 255 },
  },
];

/** Gebied outline: no fill, #00498D @ 1.0, 2px. */
const AREA_LAYERS: AddLayerObject[] = [
  {
    id: AREA_LAYER_ID,
    type: "line",
    source: AREA_SOURCE_ID,
    paint: { "line-color": "#00498D", "line-width": 2 },
  },
];

/**
 * Draw the filtered study area as MapLibre GeoJSON overlays, styled like the
 * configured studyarea's mask + outline rules. `data` of `null` clears them.
 *
 * Two sources rather than one: the mask and the outline need different
 * geometry (the disc-with-hole vs. the gebied itself) and are drawn by
 * different layer types, so they never share a feature set.
 *
 * Returns a `resync` to re-add the layers after a basemap swap (`setStyle()`
 * wipes them); call it from the map's `onLabelsReady`.
 */
export function useFilteredStudyAreaLayers(
  data: Accessor<FilteredStudyArea | null>,
  mapView: Accessor<MapViewHandle | null>,
): { resync: () => void } {
  function draw(current: FilteredStudyArea | null) {
    const map = mapView()?.map();
    if (!styleReady(map)) return;

    syncGeoJsonOverlay(map, BUFFER_SOURCE_ID, BUFFER_LAYERS, {
      type: "FeatureCollection",
      features: current ? [current.buffer] : [],
    });
    syncGeoJsonOverlay(map, AREA_SOURCE_ID, AREA_LAYERS, {
      type: "FeatureCollection",
      features: current ? current.area : [],
    });
  }

  createEffect(() => draw(data()));

  // Fires from a map event, outside any reactive scope; reading the accessor
  // here is what the React version needed `dataRef` for.
  return { resync: () => draw(data()) };
}
