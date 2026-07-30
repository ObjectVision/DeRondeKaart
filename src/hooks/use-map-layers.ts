import { useRef, useState, useCallback, useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import type { Table } from "apache-arrow";
import type { MapRef } from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { setColorFunction } from "@geomatico/maplibre-cog-protocol";
import { anchorForConfig } from "@/components/map/MapView";
import {
  loadParquetBatches,
  loadArrowBatches,
  createGeoArrowLayers,
  createGeoJsonLayers,
  buildNativeLayerDefs,
  addFlatgeobufLayer,
  removeFlatgeobufLayer,
  setFlatgeobufHidden,
  addCompositeLayer,
  removeCompositeLayer,
  childrenOf,
  isNativeVectorFormat,
  areaFilterExpression,
} from "@/layers";
import { isChildLoaded } from "@/layers/composite-manager";
import type { CompositeHost } from "@/layers";
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
  // Ref mirrors of the hidden state, so the composite host (called from a
  // moveend listener, outside React) can apply the parent's current state to
  // children that load later when the zoom enters their range.
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  const hiddenRulesRef = useRef<globalThis.Map<string, Set<string>>>(new globalThis.Map());
  // Timeseries: the step each layer currently shows, and which are playing.
  // Ref mirrors let the interval tick read current state without re-arming.
  const [layerSteps, setLayerSteps] = useState<globalThis.Map<string, number>>(new globalThis.Map());
  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  const layerStepsRef = useRef<globalThis.Map<string, number>>(new globalThis.Map());

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

  /**
   * Load one config's data and put its layers on the map — the format
   * dispatch shared by addLayer (top-level entries) and the composite host
   * (children). `isCancelled` lets a caller drop late deck batches after the
   * config was unloaded again (a composite child whose zoom range was left
   * while its data was still streaming in).
   */
  const dispatchFormatLoad = useCallback(
    async (
      config: LayerConfig,
      mapRef: React.RefObject<MapRef | null>,
      isCancelled?: () => boolean,
    ) => {
      // Constant anchor set at layer construction from the config's `beforeid`
      // (defaults to "map-layers", below the overlay). deck.gl (interleaved)
      // inserts each layer against this anchor once it exists, so there's no
      // timing dependency on when the overlay/anchors finish loading.
      const beforeId = anchorForConfig(config);
      const onBatch = (_batchIndex: number, table: Table) => {
        if (isCancelled?.()) return;
        addDeckLayers(createGeoArrowLayers(config, table, beforeId));
      };
      if (config.format === "parquet") {
        await loadParquetBatches(config.source, onBatch);
      } else if (config.format === "geoarrow") {
        await loadArrowBatches(config.source, onBatch);
      } else if (config.format === "mvt" || config.format === "pmtiles") {
        addMvtLayer(config, mapRef);
      } else if (config.format === "cog") {
        addCogLayer(config, mapRef);
      } else if (config.format === "flatgeobuf") {
        // Native MapLibre layers with viewport-driven bbox loading.
        addFlatgeobufLayer(config, mapRef);
      } else if (config.format === "geojson") {
        // In-memory features (config.data) — no fetch, build synchronously.
        addDeckLayers(createGeoJsonLayers(config, beforeId));
      }
    },
    [addDeckLayers],
  );

  /**
   * Loading/unloading callbacks handed to the composite manager. Children are
   * never layerEntries — they exist only as deck layers / native sources on
   * the map — so a child arriving after the user hid the parent (or some of
   * its rules) has that state applied here, right after its load resolves.
   */
  const compositeHost = useMemo<CompositeHost>(
    () => ({
      addChild: async (child, mapRef) => {
        const parentId = child.id.replace(/__c\d+$/, "");
        const isCancelled = () => {
          const map = mapRef.current?.getMap();
          return !map || !isChildLoaded(map, parentId, child.id);
        };
        await dispatchFormatLoad(child, mapRef, isCancelled);

        if (hiddenIdsRef.current.has(parentId)) {
          setDeckLayers((prev) =>
            prev.map((l) => (layerBelongsTo(l.id, child.id) ? l.clone({ visible: false }) : l)),
          );
          setNativeLayerVisibility(child.id, child, mapRef, "none");
          if (child.format === "flatgeobuf") {
            setFlatgeobufHidden(child.id, mapRef, true);
          }
        }
        for (const ruleName of hiddenRulesRef.current.get(parentId) ?? []) {
          setDeckLayers((prev) =>
            prev.map((l) =>
              l.id.endsWith(`-${ruleName}`) && layerBelongsTo(l.id, child.id)
                ? l.clone({ visible: false })
                : l,
            ),
          );
          setNativeRuleVisibility(child, ruleName, false, mapRef);
        }
      },
      removeChild: (child, mapRef) => {
        setDeckLayers((prev) => prev.filter((l) => !layerBelongsTo(l.id, child.id)));
        removeNativeArtifacts(child, mapRef);
      },
    }),
    [dispatchFormatLoad],
  );

  const addLayer = useCallback(async (config: LayerConfig, mapRef: React.RefObject<MapRef | null>) => {
    updateLayerEntries((prev) => {
      if (prev.some((e) => e.config.id === config.id)) return prev;
      return [...prev, { config, visible: true }];
    });

    try {
      if (config.format === "composite") {
        // Children load/unload with the zoom via the composite manager.
        addCompositeLayer(config, mapRef, compositeHost);
      } else {
        await dispatchFormatLoad(config, mapRef);
      }
    } catch (err) {
      console.error(`Failed to load layer "${config.id}":`, err);
      updateLayerEntries((prev) => prev.filter((e) => e.config.id !== config.id));
    }
  }, [dispatchFormatLoad, compositeHost, updateLayerEntries]);

  const removeLayer = useCallback((layerId: string, mapRef: React.RefObject<MapRef | null>) => {
    const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);

    updateLayerEntries((prev) => prev.filter((e) => e.config.id !== layerId));

    // Remove deck.gl layers (geoarrow/parquet)
    setDeckLayers((prev) => prev.filter((l) => !layerBelongsTo(l.id, layerId)));

    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(layerId);
      hiddenIdsRef.current = next;
      return next;
    });

    setHiddenRules((prev) => {
      const next = new globalThis.Map(prev);
      next.delete(layerId);
      hiddenRulesRef.current = next;
      return next;
    });

    // Stop playback and forget the step, so re-adding starts fresh.
    setPlayingIds((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });
    setLayerSteps((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new globalThis.Map(prev);
      next.delete(layerId);
      layerStepsRef.current = next;
      return next;
    });

    if (!entry) return;

    // Remove native MapLibre layers and sources
    if (entry.config.format === "composite") {
      removeCompositeLayer(entry.config, mapRef);
    } else {
      removeNativeArtifacts(entry.config, mapRef);
    }
  }, [updateLayerEntries]);

  const hideLayer = useCallback((layerId: string, mapRef: React.RefObject<MapRef | null>) => {
    setHiddenIds((prev) => {
      if (prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.add(layerId);
      hiddenIdsRef.current = next;
      return next;
    });

    // deck.gl layers (geoarrow/parquet, incl. composite children via `__c`)
    setDeckLayers((prev) =>
      prev.map((l) =>
        layerBelongsTo(l.id, layerId) ? l.clone({ visible: false }) : l,
      ),
    );

    // Native MapLibre layers (MVT/COG/FlatGeobuf/composite children)
    const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
    if (entry) {
      setEntryNativeVisibility(entry.config, mapRef, "none");
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
        hiddenIdsRef.current = next;

        // deck.gl layers (geoarrow/parquet, incl. composite children via `__c`)
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) =>
            layerBelongsTo(l.id, layerId) ? l.clone({ visible: willBeVisible }) : l,
          ),
        );

        // Native MapLibre layers (MVT/COG/FlatGeobuf/composite children)
        const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
        if (entry) {
          setEntryNativeVisibility(entry.config, mapRef, willBeVisible ? "visible" : "none");
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
        hiddenRulesRef.current = next;

        // deck.gl layers (geoarrow/parquet, incl. composite children): find
        // child layer by rule name suffix
        setDeckLayers((prevLayers) =>
          prevLayers.map((l) => {
            if (l.id.endsWith(`-${ruleName}`) && layerBelongsTo(l.id, layerId)) {
              return l.clone({ visible: willBeVisible });
            }
            return l;
          }),
        );

        // Native MapLibre layers (MVT/FlatGeobuf): toggle the specific rule's
        // layer. Composite: forward to every child that has a same-named rule
        // (COG children skip — their color function is global per URL).
        const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
        if (entry && isNativeVectorFormat(entry.config.format)) {
          setNativeRuleVisibility(entry.config, ruleName, willBeVisible, mapRef);
        } else if (entry?.config.format === "composite") {
          for (const child of childrenOf(entry.config)) {
            setNativeRuleVisibility(child, ruleName, willBeVisible, mapRef);
          }
        }

        return next;
      });
    },
    [],
  );

  /**
   * Show a specific timeseries step for a layer, on every map it is on.
   * Rebuilds the layer's rule layers against the substituted source layer —
   * see `applyTimeseriesStep` for why remove+re-add is the only option.
   */
  const setLayerStep = useCallback(
    (layerId: string, value: number, mapRefs: React.RefObject<MapRef | null>[]) => {
      const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
      const ts = entry?.config.timeseries;
      if (!entry || !ts) return;

      // Clamp onto the configured grid so a slider drag can't land off-step.
      const steps = Math.round((ts.end - ts.start) / ts.step);
      const index = Math.min(Math.max(Math.round((value - ts.start) / ts.step), 0), steps);
      const next = ts.start + index * ts.step;

      const hidden = {
        layerHidden: hiddenIdsRef.current.has(layerId),
        hiddenRuleNames: hiddenRulesRef.current.get(layerId),
      };
      for (const mapRef of mapRefs) {
        applyTimeseriesStep(entry.config, next, mapRef, hidden);
      }

      setLayerSteps((prev) => {
        const updated = new globalThis.Map(prev);
        updated.set(layerId, next);
        layerStepsRef.current = updated;
        return updated;
      });
    },
    [],
  );

  /** Start/stop playback for one timeseries layer. */
  const togglePlay = useCallback((layerId: string) => {
    setPlayingIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }, []);

  /** Stop playback for one layer (no-op when it isn't playing). */
  const stopPlay = useCallback((layerId: string) => {
    setPlayingIds((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });
  }, []);

  /** Advance one step, looping back to `start` past the end. Drives playback. */
  const advanceStep = useCallback(
    (layerId: string, mapRefs: React.RefObject<MapRef | null>[]) => {
      const entry = layerEntriesRef.current.find((e) => e.config.id === layerId);
      const ts = entry?.config.timeseries;
      if (!entry || !ts) return;
      const current = layerStepsRef.current.get(layerId) ?? ts.start;
      const next = current + ts.step > ts.end ? ts.start : current + ts.step;
      setLayerStep(layerId, next, mapRefs);
    },
    [setLayerStep],
  );

  /**
   * Re-apply the area filter to both rendering paths:
   *  - deck.gl layers are re-cloned with a bumped update trigger so their
   *    color accessors (wrapped by the layer factory) re-evaluate the
   *    selection. `clone` preserves `visible`, so legend layer/rule toggles
   *    survive filter changes.
   *  - native MapLibre layers (mvt/pmtiles/flatgeobuf) have no Arrow rows, so
   *    the selection is pushed down as a layer filter expression instead.
   * COG is a raster and stays unfiltered.
   */
  const refreshAreaFilter = useCallback(
    (version: number, mapRefs: React.RefObject<MapRef | null>[] = []) => {
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
      for (const entry of layerEntriesRef.current) {
        for (const mapRef of mapRefs) {
          refreshNativeAreaFilter(entry.config, mapRef);
        }
      }
    },
    [],
  );

  /**
   * Re-apply imperative MVT/COG/FlatGeobuf/composite entries to a map. Used
   * when a map mounts after addLayer was already called (e.g. the right map
   * becoming ready after the first layer was added to it) and after a basemap
   * swap wipes the style. Safe to call repeatedly — the helpers skip
   * sources/layers that already exist.
   */
  const syncImperativeLayers = useCallback(
    (mapRef: React.RefObject<MapRef | null>) => {
      for (const entry of layerEntriesRef.current) {
        if (entry.config.format === "mvt" || entry.config.format === "pmtiles") {
          addMvtLayer(entry.config, mapRef);
        } else if (entry.config.format === "cog") {
          addCogLayer(entry.config, mapRef);
        } else if (entry.config.format === "flatgeobuf") {
          addFlatgeobufLayer(entry.config, mapRef);
        } else if (entry.config.format === "composite") {
          addCompositeLayer(entry.config, mapRef, compositeHost);
        }
      }
    },
    [compositeHost],
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
      layerSteps,
      playingIds,
      addLayer,
      removeLayer,
      hideLayer,
      toggleLayer,
      toggleRule,
      setLayerStep,
      togglePlay,
      stopPlay,
      advanceStep,
      refreshAreaFilter,
      syncImperativeLayers,
    }),
    [
      layerEntries,
      deckLayers,
      hiddenIds,
      hiddenRules,
      layerSteps,
      playingIds,
      addLayer,
      removeLayer,
      hideLayer,
      toggleLayer,
      toggleRule,
      setLayerStep,
      togglePlay,
      stopPlay,
      advanceStep,
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

/** Source id for a native vector-tile config (MVT tile template or PMTiles archive). */
function tileSourceId(config: LayerConfig): string {
  return config.format === "pmtiles"
    ? `pmtiles-source-${config.id}`
    : `mvt-source-${config.id}`;
}

/**
 * Add a native MapLibre vector-tile source + one layer per style rule.
 * Handles both MVT (a `{z}/{x}/{y}` tile template) and PMTiles (a single
 * archive read via the `pmtiles://` protocol registered in MapView).
 * Module-scope: depends only on the config and the target map.
 */
function addMvtLayer(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
  const map = mapRef.current?.getMap();
  if (!map) return;

  // A timeseries layer's configured `sourceLayer` is a template — resolve it to
  // the start step before the first addLayer, or MapLibre would be handed the
  // literal placeholder and render nothing.
  if (config.timeseries && config.sourceLayer?.includes(config.timeseries.placeholder)) {
    config.sourceLayer = timeseriesSourceLayer(config, config.timeseries.start);
  }

  const beforeId = anchorForConfig(config);
  const sourceId = tileSourceId(config);

  if (!map.getSource(sourceId)) {
    if (config.format === "pmtiles") {
      // `url` (not `tiles`): the protocol handler reads the archive's header
      // for its own tile scheme and zoom range, so no template is needed.
      map.addSource(sourceId, {
        type: "vector",
        url: `pmtiles://${absoluteTileUrl(config.source)}`,
      });
    } else {
      map.addSource(sourceId, {
        type: "vector",
        tiles: [absoluteTileUrl(config.source)],
        minzoom: 0,
        maxzoom: 14,
      });
    }
  }

  addRuleLayers(map, config, sourceId, beforeId);
}

/**
 * Add one MapLibre layer per style rule for a native vector-tile config.
 * Split out of `addMvtLayer` because the timeseries stepper rebuilds these
 * layers (MapLibre has no setter for `source-layer`, so switching the rendered
 * source layer means remove + re-add) and must produce identical specs.
 * Existing layers are left alone — callers that need a rebuild remove first.
 */
function addRuleLayers(
  map: MapLibreMap,
  config: LayerConfig,
  sourceId: string,
  beforeId: string,
) {
  const defs = buildNativeLayerDefs(config);
  for (const def of defs) {
    if (map.getLayer(def.id)) continue;

    const layerSpec: Record<string, unknown> = {
      id: def.id,
      source: sourceId,
      type: def.type,
      paint: def.paint,
      layout: def.layout,
    };

    // Zoom bounds (composite children): exact cutoff even mid-gesture.
    if (config.minzoom !== undefined) layerSpec.minzoom = config.minzoom;
    if (config.maxzoom !== undefined) layerSpec.maxzoom = config.maxzoom;

    // Use sourceLayer from config if specified
    if (config.sourceLayer) {
      layerSpec["source-layer"] = config.sourceLayer;
    }

    // Rule filter AND the active area filter: a layer added while a gebied is
    // selected must arrive already filtered.
    const filter = combinedNativeFilter(def);
    if (filter) {
      layerSpec.filter = filter;
    }

    // Native addLayer throws if beforeId names a missing layer — fall back to
    // appending when the anchor isn't in the style yet (it will be once the
    // overlay/anchors finish loading; imperative layers are re-synced then).
    map.addLayer(layerSpec as any, map.getLayer(beforeId) ? beforeId : undefined);
  }
}

/**
 * The `sourceLayer` template a timeseries config resolves against.
 *
 * `config.sourceLayer` is rewritten in place as steps are applied (so a basemap
 * swap replays the current step), which would destroy the placeholder after the
 * first step. The original template is stashed here, keyed by the config
 * object, the first time that layer is stepped.
 */
const timeseriesTemplates = new WeakMap<LayerConfig, string>();

/** Substitute the timeseries placeholder in a source layer name. */
export function timeseriesSourceLayer(config: LayerConfig, value: number): string {
  const ts = config.timeseries;
  if (!ts || !config.sourceLayer) return config.sourceLayer ?? "";
  // Remember the template before the first substitution overwrites it.
  let template = timeseriesTemplates.get(config);
  if (template === undefined) {
    template = config.sourceLayer;
    timeseriesTemplates.set(config, template);
  }
  return template.split(ts.placeholder).join(String(value));
}

/**
 * Point a timeseries layer at a different step by rebuilding its rule layers.
 *
 * MapLibre exposes no setter for `source-layer` (only filter/layout/paint/zoom),
 * so the layers are removed and re-added. The SOURCE is deliberately left in
 * place: the PMTiles archive header, directory cache and already-fetched tiles
 * all live there, so stepping stays cheap.
 *
 * Rule layer ids are derived from `config.id` + rule name (not `sourceLayer`),
 * so ids are stable across steps and picking/legend keep working — but the
 * rebuilt layers arrive visible, so the caller's current hidden state has to be
 * reapplied here.
 */
function applyTimeseriesStep(
  config: LayerConfig,
  value: number,
  mapRef: React.RefObject<MapRef | null>,
  hidden: { layerHidden: boolean; hiddenRuleNames: Set<string> | undefined },
) {
  const map = mapRef.current?.getMap();
  if (!map || !config.timeseries) return;

  const nextSourceLayer = timeseriesSourceLayer(config, value);
  if (nextSourceLayer === config.sourceLayer) return;

  const defs = buildNativeLayerDefs(config);
  for (const def of defs) {
    if (map.getLayer(def.id)) map.removeLayer(def.id);
  }

  // Mutated in place: `layerEntriesRef` holds this same object, so a basemap
  // swap replays the CURRENT step rather than reverting to the start value.
  config.sourceLayer = nextSourceLayer;

  const sourceId = tileSourceId(config);
  if (!map.getSource(sourceId)) return;
  addRuleLayers(map, config, sourceId, anchorForConfig(config));

  // Fresh layers default to visible — restore what the user had hidden.
  for (const def of buildNativeLayerDefs(config)) {
    if (!map.getLayer(def.id)) continue;
    // ruleName is "" for a flat-styled layer (no per-rule toggles).
    const ruleHidden = def.ruleName !== "" && hidden.hiddenRuleNames?.has(def.ruleName);
    if (hidden.layerHidden || ruleHidden) {
      map.setLayoutProperty(def.id, "visibility", "none");
    }
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
    const layerSpec: Record<string, unknown> = {
      id: layerId,
      source: sourceId,
      type: "raster",
      paint: { "raster-opacity": config.style.opacity ?? 1 },
    };
    // Zoom bounds (composite children): exact cutoff even mid-gesture.
    if (config.minzoom !== undefined) layerSpec.minzoom = config.minzoom;
    if (config.maxzoom !== undefined) layerSpec.maxzoom = config.maxzoom;
    map.addLayer(
      layerSpec as never,
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
  } else if (isNativeVectorFormat(config.format)) {
    const defs = buildNativeLayerDefs(config);
    for (const def of defs) {
      if (map.getLayer(def.id)) {
        map.setLayoutProperty(def.id, "visibility", visibility);
      }
    }
  }
}

/**
 * Remove the native MapLibre sources/layers a config created (MVT/COG/
 * FlatGeobuf). Module-scope; shared by removeLayer (top-level entries) and
 * the composite host (children). Deck layers are removed separately by the
 * callers via setDeckLayers + layerBelongsTo.
 */
function removeNativeArtifacts(config: LayerConfig, mapRef: React.RefObject<MapRef | null>) {
  const map = mapRef.current?.getMap();
  if (!map) return;

  if (config.format === "mvt" || config.format === "pmtiles") {
    for (const def of buildNativeLayerDefs(config)) {
      if (map.getLayer(def.id)) map.removeLayer(def.id);
    }
    const sourceId = tileSourceId(config);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } else if (config.format === "cog") {
    const cogLayerId = `cog-layer-${config.id}`;
    const cogSourceId = `cog-source-${config.id}`;
    if (map.getLayer(cogLayerId)) map.removeLayer(cogLayerId);
    if (map.getSource(cogSourceId)) map.removeSource(cogSourceId);
  } else if (config.format === "flatgeobuf") {
    removeFlatgeobufLayer(config, mapRef);
  }
}

/**
 * Combine a native layer's own rule filter with the active area filter.
 * Returns undefined when neither applies (MapLibre then shows everything).
 */
function combinedNativeFilter(def: { filter?: unknown[] }): unknown[] | undefined {
  const area = areaFilterExpression();
  if (!area) return def.filter;
  return def.filter ? ["all", def.filter, area] : area;
}

/**
 * Re-apply the area filter to every native vector layer of a config. Native
 * layers have no Arrow rows to re-evaluate (that's what refreshAreaFilter does
 * for deck.gl), so the selection is pushed down as a MapLibre filter instead.
 */
function refreshNativeAreaFilter(
  config: LayerConfig,
  mapRef: React.RefObject<MapRef | null>,
) {
  const map = mapRef.current?.getMap();
  if (!map) return;
  const targets = config.format === "composite" ? childrenOf(config) : [config];
  for (const target of targets) {
    if (!isNativeVectorFormat(target.format)) continue;
    for (const def of buildNativeLayerDefs(target)) {
      if (!map.getLayer(def.id)) continue;
      map.setFilter(def.id, combinedNativeFilter(def) as never);
    }
  }
}

/**
 * Toggle one GeoStyler rule's native layer for a config (MVT/FlatGeobuf).
 * Configs without a same-named rule (or without native rule layers at all —
 * COG, deck formats) are a no-op.
 */
function setNativeRuleVisibility(
  config: LayerConfig,
  ruleName: string,
  visible: boolean,
  mapRef: React.RefObject<MapRef | null>,
) {
  if (!isNativeVectorFormat(config.format)) return;
  const map = mapRef.current?.getMap();
  if (!map) return;
  const ruleLayerId = buildNativeLayerDefs(config).find((d) => d.ruleName === ruleName)?.id;
  if (ruleLayerId && map.getLayer(ruleLayerId)) {
    map.setLayoutProperty(ruleLayerId, "visibility", visible ? "visible" : "none");
  }
}

/**
 * Apply visibility to everything native an entry owns: the config's own
 * MapLibre layers, a flatgeobuf's fetch loop (paused while hidden), and — for
 * a composite — the same for every child.
 */
function setEntryNativeVisibility(
  config: LayerConfig,
  mapRef: React.RefObject<MapRef | null>,
  visibility: "visible" | "none",
) {
  const targets = config.format === "composite" ? childrenOf(config) : [config];
  for (const target of targets) {
    setNativeLayerVisibility(target.id, target, mapRef, visibility);
    if (target.format === "flatgeobuf") {
      setFlatgeobufHidden(target.id, mapRef, visibility === "none");
    }
  }
}

/**
 * Check if a deck layer ID belongs to a given config ID. GeoArrow layers are
 * per record batch (`{configId}__b{n}` / `{configId}__b{n}-{ruleName}`);
 * GeoJson layers use `{configId}-geojson`; composite children prefix their
 * synthesized `{configId}__c{n}` id onto all of the above.
 */
function layerBelongsTo(deckLayerId: string, configId: string): boolean {
  return (
    deckLayerId === configId ||
    deckLayerId.startsWith(configId + "-") ||
    deckLayerId.startsWith(configId + "__b") ||
    deckLayerId.startsWith(configId + "__c")
  );
}

/**
 * Sibling key: a deck layer id with its `__b{n}` batch segment wildcarded, so
 * the same config/rule layer across different record batches compares equal.
 */
function batchSiblingKey(deckLayerId: string): string {
  return deckLayerId.replace(/__b\d+/, "__b*");
}
