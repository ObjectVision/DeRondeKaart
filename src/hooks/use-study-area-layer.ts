import { useEffect, useState } from "react";
import type { Layer } from "@deck.gl/core";
import type { Table } from "apache-arrow";
import {
  loadLayerConfigs,
  getLayerConfigById,
  loadParquetBatches,
  loadGeoParquetBatches,
  loadArrowBatches,
  createGeoArrowLayers,
} from "@/layers";
import type { LayerConfig } from "@/layers";

/**
 * Load the configured "study area" layer as a set of deck.gl layers that are
 * always active and meant to be pinned on top of everything (the caller enforces
 * z-order via `bringStudyareaToTop`). The layers are made non-pickable so the
 * always-on-top layer never swallows clicks intended for the data layers beneath
 * it (matches the layer's `excludeFromPicking` flag).
 *
 * Loaded through its own channel (not `useMapLayers`) so it stays out of the
 * legend, feature-picking, and comparison logic. Returns `[]` until loaded, or
 * when `studyAreaId` is undefined / not found / an unsupported format.
 */
export function useStudyAreaLayer(studyAreaId: string | undefined): Layer[] {
  const [layers, setLayers] = useState<Layer[]>([]);

  useEffect(() => {
    if (!studyAreaId) {
      setLayers([]);
      return;
    }

    let cancelled = false;
    const acc: Layer[] = [];

    function addBatch(config: LayerConfig, batchIndex: number, table: Table) {
      // beforeId omitted — order is enforced via bringStudyareaToTop, not beforeId.
      const built = createGeoArrowLayers(config, table, batchIndex).map((l) =>
        l.clone({ pickable: false }),
      );
      acc.push(...built);
      if (!cancelled) setLayers([...acc]);
    }

    (async () => {
      try {
        const configs = await loadLayerConfigs();
        const config = getLayerConfigById(configs, studyAreaId);
        if (!config) {
          console.warn(`map.json: studyarea "${studyAreaId}" not found in layers.json`);
          return;
        }

        const onBatch = (batchIndex: number, table: Table) =>
          addBatch(config, batchIndex, table);

        if (config.format === "parquet") {
          await loadParquetBatches(config.source, onBatch);
        } else if (config.format === "geoparquet") {
          await loadGeoParquetBatches(config.source, onBatch);
        } else if (config.format === "geoarrow") {
          await loadArrowBatches(config.source, onBatch);
        } else {
          console.warn(
            `map.json: studyarea "${studyAreaId}" has unsupported format "${config.format}" (expected geoparquet/parquet/geoarrow)`,
          );
        }
      } catch (err) {
        if (!cancelled) console.error(`Failed to load studyarea "${studyAreaId}":`, err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studyAreaId]);

  return layers;
}
