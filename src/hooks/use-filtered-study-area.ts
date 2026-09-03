import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AddLayerObject } from "maplibre-gl";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { loadParquetBatches } from "@/layers";
import { extendRowBbox, rowGeometryToGeoJson, type BBox } from "@/layers/box-filter";
import type { AreaFilterState } from "@/hooks/use-area-filter";
import { SELECTION_DASHARRAY } from "@/layers/mvt-style";
import type { MapViewHandle } from "@/components/map/map-view-config";
import { styleReady, syncGeoJsonOverlay } from "@/layers/geojson-overlay";

/**
 * The gebiedsfilter's outline, drawn ON TOP of the configured study area.
 *
 * Additive, not a replacement: the study area keeps its own mask and border,
 * and a selected gebied is marked by a dashed line over it. It used to swap the
 * two — removing the studyarea layers and drawing a 200 km grey mask disc in
 * their place — but that disc painted the same `#EBECF0` the studyarea's own
 * `outer` rule does, so showing both would have doubled the grey everywhere
 * outside the study area.
 */
export interface FilteredStudyArea {
  /** The selected gebied geometry (one feature per matching table row). */
  area: Feature<Polygon | MultiPolygon>[];
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
        // The bbox is still read per row: a selection whose rows carry no usable
        // geometry leaves it infinite, and drawing an empty outline would read
        // as "the filter did nothing".
        if (area.length === 0 || !Number.isFinite(bbox[0])) return;

        if (!cancelled) setResult({ token, data: { area } });
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

const AREA_SOURCE_ID = "filtered-study-area";
const AREA_LAYER_ID = "filtered-study-area-line";

/**
 * The study area's own border colour, mirrored from the studyarea layer's
 * geostyler rules (`studiegebied_limburg` in
 * `configs/woonzorglimburg/layers.json`, `outlineColor` on every gebied rule).
 *
 * Duplicated as a literal rather than resolved from the config: this overlay
 * is only reachable where a gebiedsfilter exists, and woonzorglimburg is the
 * only project whose `filter.json` is non-empty. Threading the studyarea id in
 * to read the colour back would be plumbing for a case that cannot arise.
 */
const STUDY_AREA_BORDER = "#00498D";

/** Gebied outline: no fill, the study-area border colour, 2px, dashed. */
const AREA_LAYERS: AddLayerObject[] = [
  {
    id: AREA_LAYER_ID,
    type: "line",
    source: AREA_SOURCE_ID,
    paint: {
      "line-color": STUDY_AREA_BORDER,
      "line-width": 2,
      // Dashed so it stays legible where a gebied's edge runs along the
      // study-area border it shares a colour with — a solid line there would
      // be indistinguishable from the border underneath.
      "line-dasharray": SELECTION_DASHARRAY,
    },
  },
];

/**
 * Draw the selected gebied's outline as a MapLibre GeoJSON overlay, over the
 * configured study area. `data` of `null` clears it.
 *
 * Added with no `beforeId`, so it sits above every anchor — including the
 * `studyarea-layers` band. That is deliberate: the dash exists to stay readable
 * exactly where the two lines coincide, which anchoring it below would defeat.
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
