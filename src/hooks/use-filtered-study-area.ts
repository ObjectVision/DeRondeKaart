import { useEffect, useMemo, useState } from "react";
import type { Layer } from "@deck.gl/core";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { loadParquetBatches } from "@/layers";
import { extendRowBbox, rowGeometryToGeoJson, type BBox } from "@/layers/box-filter";
import type { AreaFilterState } from "@/hooks/use-area-filter";

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

/** Mean Earth radius (km), for the spherical destination formula. */
const EARTH_RADIUS_KM = 6371;
const BUFFER_RADIUS_KM = 200;
const CIRCLE_SEGMENTS = 64;

/** Great-circle destination point from (lng, lat) along a bearing (radians). */
function destination(
  lng: number,
  lat: number,
  bearingRad: number,
  distanceKm: number,
): Position {
  const δ = distanceKm / EARTH_RADIUS_KM;
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

/** Closed ring approximating a circle of `radiusKm` around a center. */
function circleRing(centerLng: number, centerLat: number, radiusKm: number): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const bearing = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    ring.push(destination(centerLng, centerLat, bearing, radiusKm));
  }
  return ring;
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
export function useFilteredStudyArea(areaFilter: AreaFilterState): FilteredStudyArea | null {
  const { entries, selections } = areaFilter;

  // Finest level with a selection wins (same walk as the filter fly-to). The
  // token identifies the selection, so a stale async result is never returned.
  const finest = useMemo(() => {
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
  }, [entries, selections]);

  const [result, setResult] = useState<{ token: string; data: FilteredStudyArea } | null>(
    null,
  );

  useEffect(() => {
    if (!finest) return; // nothing selected — the token gate below yields null
    let cancelled = false;
    const { entry, codes, token } = finest;
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
            coordinates: [circleRing(centerLng, centerLat, BUFFER_RADIUS_KM), ...holes],
          },
          properties: {},
        };
        if (!cancelled) setResult({ token, data: { buffer, area } });
      } catch (err) {
        console.warn(`Filtered study area failed for "${entry.name}":`, err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [finest]);

  // Only hand out data matching the CURRENT selection: no selection or a
  // still-loading one falls back to the configured studyarea (null).
  return finest && result && result.token === finest.token ? result.data : null;
}

/**
 * Build the filtered study area as deck.gl layers, styled like the configured
 * studyarea's mask + outline rules. Returns `[]` when there is no data. Call
 * once per map — Layer instances must not be shared across two Deck overlays.
 */
export function useFilteredStudyAreaLayers(
  data: FilteredStudyArea | null,
  suffix: string,
): Layer[] {
  return useMemo(() => {
    if (!data) return [];
    return [
      // Outside mask: #EBECF0 @ 0.5, no outline.
      new GeoJsonLayer({
        id: `filtered-study-buffer-${suffix}`,
        data: { type: "FeatureCollection" as const, features: [data.buffer] },
        pickable: false,
        filled: true,
        stroked: false,
        getFillColor: [235, 236, 240, 128],
      }),
      // Gebied outline: transparent fill, #00498D @ 1.0, 2px.
      new GeoJsonLayer({
        id: `filtered-study-area-${suffix}`,
        data: { type: "FeatureCollection" as const, features: data.area },
        pickable: false,
        filled: false,
        stroked: true,
        getLineColor: [0, 73, 141, 255],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
      }),
    ];
  }, [data, suffix]);
}
