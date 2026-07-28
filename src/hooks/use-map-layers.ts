import { useRef, useState, useCallback, useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import type { Table } from "apache-arrow";
import type { MapRef } from "react-map-gl/maplibre";
import { setColorFunction } from "@geomatico/maplibre-cog-protocol";
import { anchorForConfig } from "@/components/map/MapView";
import {
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayers,
  createGeoJsonLayers,
  buildMvtLayerDefs,
} from "@/layers";
import { buildCogColorFunction } from "@/layers/cog-style";
import type { LayerConfig } from "@/layers";

export interface LayerEntry {
  config: LayerConfig;
  visible: boolean;
}

/**
 * Source URLs that already have a COG color function registered. The
 * cog-protocol keys renderers by URL globally, so registering once per source
 * is enough (and the left / right map share the same URL).
 */
const registeredCogColorUrls = new Set<string>();

export function useMapLayers() {
  const [deckLayers, setDeckLayers] = useState<Layer[]>([]);
  const [layerEntries, setLayerEntries] = useState<LayerEntry[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [hiddenRules, setHiddenRules] = useState<globalThis.Map<string, Set<string>>>(new globalThis.Map());
  const layerEntriesRef = useRef<LayerEntry[]>([]);

  /**
   * Add deck layers, replacing any existing layer with the same id. The
   * loaders emit cumulative tables and the factory keys layers per record
   * batch (`{configId}__b{n}`), so re-emitted batches swap their previous
   * layer (a cheap id-matched diff) and only genuinely new batches append.
   * `visible` is carried over from the replaced layer — and, for appended
   * batches, from an earlier-batch sibling — so a legend layer/rule toggle
   * survives batches that keep arriving mid-load.
   */
  const addDeckLayers = useCallback((newLayers: Layer[]) => {
    setDeckLayers((prev) => {
      const incoming = new globalThis.Map(newLayers.map((l) => [l.id, l]));
      // Sibling keys of currently hidden layers: a new batch's layer inherits
      // hidden when its config/rule siblings from earlier batches are hidden.
      const hiddenSiblings = new Set(
        prev
          .filter((l) => (l.props as { visible?: boolean }).visible === false)
          .map((l) => batchSiblingKey(l.id)),
      );
      const next = prev.map((l) => {
        const replacement = incoming.get(l.id);
        if (!replacement) return l;
        incoming.delete(l.id);
        const visible = (l.props as { visible?: boolean }).visible;
        return visible === false ? replacement.clone({ visible: false }) : replacement;
      });
      if (incoming.size === 0) return next;
      const appended = [...incoming.values()].map((l) =>
        hiddenSiblings.has(batchSiblingKey(l.id)) ? l.clone({ visible: false }) : l,
      );
      return [...next, ...appended];
    });
  }, []);

  const updateLayerEntries = useCallback(
    (updater: (prev: LayerEntry[]) => LayerEntry[]) => {
      setLayerEntries((prev) => {
        const next = updater(prev);
        layerEntriesRef.current = next;
        return next;
      });
    },
    [],
  );

  const addLayer = useCallback(async (config: LayerConfig, mapRef: React.RefObject<MapRef | null>) => {
    updateLayerEntries((prev) => {
      if (prev.some((e) => e.config.id === config.id)) return prev;
      return [...prev, { config, visible: true }];
    });

    // Constant anchor set at layer construction from the config's `beforeid`
    // (defaults to "map-layers", below the overlay). deck.gl (interleaved)
    // inserts each layer against this anchor once it exists, so there's no
    // timing dependency on when the overlay/anchors finish loading.
    const beforeId = anchorForConfig(config);

    try {
      const onBatch = (_batchIndex: number, table: Table) => {
        addDeckLayers(createGeoArrowLayers(config, table, beforeId));
      };
      if (config.format === "parquet") {
        await loadParquetBatches(config.source, onBatch);
      } else if (config.format === "geoarrow") {
        await loadArrowBatches(config.source, onBatch);
      } else if (config.format === "mvt") {
        addMvtLayer(config, mapRef);
      } else if (config.format === "cog") {
        addCogLayer(config, mapRef);
      } else if (config.format === "geojson") {
        // In-memory features (config.data) — no fetch, build synchronously.
        addDeckLayers(createGeoJsonLayers(config, beforeId));
      }
    } catch (err) {
      console.error(`Failed to load layer "${config.id}":`, err);
      updateLayerEntries((prev) => prev.filter((e) => e.config.id !== config.id));
    }
  }, [addDeckLayers, updateLayerEntries]);

  const removeLayer = useCallback((layerId: string, mapRef: React.RefObject<MapRef | null>) => {
    const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);

    updateLayerEntries((prev) => prev.filter((e) => e.config.id !== layerId));

    // Remove deck.gl layers (geoarrow/parquet)
    setDeckLayers((prev) => prev.filter((l) => !layerBelongsTo(l.id, layerId)));

    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });

    setHiddenRules((prev) => {
      const next = new globalThis.Map(prev);
      next.delete(layerId);
      return next;
    });

    // Remove native MapLibre layers and sources
    const map = mapRef.current?.getMap();
    if (!map || !entry) return;

    if (entry.config.format === "mvt") {
      const defs = buildMvtLayerDefs(entry.config);
      for (const def of defs) {
        if (map.getLayer(def.id)) map.removeLayer(def.id);
      }
      const sourceId = `mvt-source-${layerId}`;
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } else if (entry.config.format === "cog") {
      const cogLayerId = `cog-layer-${layerId}`;
      const cogSourceId = `cog-source-${layerId}`;
      if (map.getLayer(cogLayerId)) map.removeLayer(cogLayerId);
      if (map.getSource(cogSourceId)) map.removeSource(cogSourceId);
    }
  }, [updateLayerEntries]);

  const hideLayer = useCallback((layerId: string, mapRef: React.RefObject<MapRef | null>) => {
    setHiddenIds((prev) => {
      if (prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.add(layerId);
      return next;
    });

    // deck.gl layers (geoarrow/parquet)
    setDeckLayers((prev) =>
      prev.map((l) =>
        layerBelongsTo(l.id, layerId) ? l.clone({ visible: false }) : l,
      ),
    );

    // Native MapLibre layers (MVT/COG)
    const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
    if (entry) {
      setNativeLayerVisibility(layerId, entry.config, mapRef, "none");
    }
  }, []);

  const toggleLayer = useCallback(
    (layerId: string, mapRef: React.RefObject<MapRef | null>) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        const willBeVisible = next.has(layerId);
        if (willBeVisible) {
          next.delete(layerId);
        } else {
          next.add(layerId);
        }

        // deck.gl layers (geoarrow/parquet)
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) =>
            layerBelongsTo(l.id, layerId) ? l.clone({ visible: willBeVisible }) : l,
          ),
        );

        // Native MapLibre layers (MVT/COG)
        const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
        if (entry) {
          setNativeLayerVisibility(
            layerId,
            entry.config,
            mapRef,
            willBeVisible ? "visible" : "none",
          );
        }

        return next;
      });
    },
    [],
  );

  const toggleRule = useCallback(
    (layerId: string, ruleName: string, mapRef: React.RefObject<MapRef | null>) => {
      setHiddenRules((prev) => {
        const next = new globalThis.Map(prev);
        const layerRules = new Set(next.get(layerId) ?? []);

        const willBeVisible = layerRules.has(ruleName);
        if (willBeVisible) {
          layerRules.delete(ruleName);
        } else {
          layerRules.add(ruleName);
        }

        if (layerRules.size === 0) {
          next.delete(layerId);
        } else {
          next.set(layerId, layerRules);
        }

        // deck.gl layers (geoarrow/parquet): find child layer by rule name suffix
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) => {
            if (l.id.endsWith(`-${ruleName}`) && layerBelongsTo(l.id, layerId)) {
              return l.clone({ visible: willBeVisible });
            }
            return l;
          }),
        );

        // Native MapLibre layers (MVT): toggle the specific rule's layer
        const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
        if (entry?.config.format === "mvt") {
          const map = mapRef.current?.getMap();
          const mvtLayerId = `mvt-layer-${layerId}-${ruleName}`;
          if (map?.getLayer(mvtLayerId)) {
            map.setLayoutProperty(mvtLayerId, "visibility", willBeVisible ? "visible" : "none");
          }
        }

        return next;
      });
    },
    [],
  );

  /**
   * Re-clone every deck.gl layer with a bumped area-filter update trigger so
   * their color accessors (wrapped by the layer factory) re-evaluate against
   * the new selection. `clone` preserves `visible`, so legend layer/rule
   * toggles survive filter changes. MVT/COG are native MapLibre layers and
   * are intentionally not filtered.
   */
  const refreshAreaFilter = useCallback((version: number) => {
    setDeckLayers((prev) =>
      prev.map((l) =>
        l.clone({
          updateTriggers: {
            ...(l.props as { updateTriggers?: Record<string, unknown> }).updateTriggers,
            all: `area-filter-${version}`,
          },
        } as Record<string, unknown>),
      ),
    );
  }, []);

  /**
   * Re-apply imperative MVT/COG entries to a map. Used when a map mounts
   * after addLayer was already called (e.g. the right map becoming ready after the
   * first layer was added to it). Safe to call repeatedly — the MVT/COG
   * helpers skip sources/layers that already exist.
   */
  const syncImperativeLayers = useCallback(
    (mapRef: React.RefObject<MapRef | null>) => {
      for (const entry of layerEntriesRef.current) {
        if (entry.config.format === "mvt") {
          addMvtLayer(entry.config, mapRef);
        } else if (entry.config.format === "cog") {
          addCogLayer(entry.config, mapRef);
        }
      }
    },
    [],
  );

  // Stable object identity (all functions are useCallback'd): consumers'
  // useMemo/useCallback chains and React.memo children only invalidate when the
  // layer state itself changes — not on every render of the caller.
  return useMemo(
    () => ({
      layerEntries,
      deckLayers,
      hiddenIds,
      hiddenRules,
      addLayer,
      removeLayer,
      hideLayer,
      toggleLayer,
      toggleRule,
      refreshAreaFilter,
      syncImperativeLayers,
    }),
    [
      layerEntries,
      deckLayers,
      hiddenIds,
      hiddenRules,
      addLayer,
      removeLayer,
      hideLayer,
      toggleLayer,
      toggleRule,
      refreshAreaFilter,
      syncImperativeLayers,
    ],
  );
}

/**
 * Make a tile URL template absolute.
 *
 * MapLibre hands tile URLs to `new Request(...)` (in a worker), which has no
 * document base to resolve against — a root-relative template like
 * "/sa-tiles/…/{z}/{x}/{y}.pbf" throws "Failed to parse URL". Prefixing the
 * current origin lets layers.json stay origin-agnostic, so the same config
 * works against the Vite dev proxy and the nginx proxy in production.
 *
 * Absolute URLs (with a scheme) are returned untouched. The `{z}/{x}/{y}`
 * placeholders are preserved: only the origin is prepended, no URL parsing.
 */
function absoluteTileUrl(source: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
  if (source.startsWith("/")) return window.location.origin + source;
  return source;
}

/**
 * Add a native MapLibre vector-tile source + one layer per style rule.
 * Module-scope: depends only on the config and the target map.
 */
function addMvtLayer(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
  const map = mapRef.current?.getMap();
  if (!map) return;

  const beforeId = anchorForConfig(config);
  const sourceId = `mvt-source-${config.id}`;

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "vector",
      tiles: [absoluteTileUrl(config.source)],
      minzoom: 0,
      maxzoom: 14,
    });
  }

  const defs = buildMvtLayerDefs(config);
  for (const def of defs) {
    if (map.getLayer(def.id)) continue;

    const layerSpec: Record<string, unknown> = {
      id: def.id,
      source: sourceId,
      type: def.type,
      paint: def.paint,
      layout: def.layout,
    };

    // Use sourceLayer from config if specified
    if (config.sourceLayer) {
      layerSpec["source-layer"] = config.sourceLayer;
    }

    if (def.filter) {
      layerSpec.filter = def.filter;
    }

    // Native addLayer throws if beforeId names a missing layer — fall back to
    // appending when the anchor isn't in the style yet (it will be once the
    // overlay/anchors finish loading; imperative layers are re-synced then).
    map.addLayer(layerSpec as any, map.getLayer(beforeId) ? beforeId : undefined);
  }
}

/** Add a native MapLibre raster source/layer for a COG. Module-scope. */
function addCogLayer(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
  const map = mapRef.current?.getMap();
  if (!map) return;

  const beforeId = anchorForConfig(config);
  const sourceId = `cog-source-${config.id}`;
  const layerId = `cog-layer-${config.id}`;

  // Register a band-driven geostyler color function for this COG source (once
  // per URL). Must happen before the source is added so the first tiles render
  // styled. Skipped when the COG already contains its colors (`embeddedColors`)
  // — there the rules are a legend key only. Without rules the protocol renders
  // the raw raster.
  if (
    config.geostyler?.rules?.length &&
    !config.embeddedColors &&
    !registeredCogColorUrls.has(config.source)
  ) {
    setColorFunction(config.source, buildCogColorFunction(config.geostyler));
    registeredCogColorUrls.add(config.source);
  }

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "raster",
      url: `cog://${config.source}`,
      tileSize: 256,
    });
    map.addLayer(
      {
        id: layerId,
        source: sourceId,
        type: "raster",
        paint: { "raster-opacity": config.style.opacity ?? 1 },
      },
      // Append when the anchor isn't in the style yet (see addMvtLayer note).
      map.getLayer(beforeId) ? beforeId : undefined,
    );
  }
}

/** Set visibility on all native MapLibre layers belonging to a config */
function setNativeLayerVisibility(
  configId: string,
  config: LayerConfig,
  mapRef: React.RefObject<MapRef | null>,
  visibility: "visible" | "none",
) {
  const map = mapRef.current?.getMap();
  if (!map) return;

  if (config.format === "cog") {
    const cogLayerId = `cog-layer-${configId}`;
    if (map.getLayer(cogLayerId)) {
      map.setLayoutProperty(cogLayerId, "visibility", visibility);
    }
  } else if (config.format === "mvt") {
    const defs = buildMvtLayerDefs(config);
    for (const def of defs) {
      if (map.getLayer(def.id)) {
        map.setLayoutProperty(def.id, "visibility", visibility);
      }
    }
  }
}

/**
 * Check if a deck layer ID belongs to a given config ID. GeoArrow layers are
 * per record batch (`{configId}__b{n}` / `{configId}__b{n}-{ruleName}`);
 * GeoJson layers use `{configId}-geojson`.
 */
function layerBelongsTo(deckLayerId: string, configId: string): boolean {
  return (
    deckLayerId === configId ||
    deckLayerId.startsWith(configId + "-") ||
    deckLayerId.startsWith(configId + "__b")
  );
}

/**
 * Sibling key: a deck layer id with its `__b{n}` batch segment wildcarded, so
 * the same config/rule layer across different record batches compares equal.
 */
function batchSiblingKey(deckLayerId: string): string {
  return deckLayerId.replace(/__b\d+/, "__b*");
}
