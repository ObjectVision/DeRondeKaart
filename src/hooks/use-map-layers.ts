import { createSignal, type Accessor } from "solid-js";
import type { MapAccessor } from "@/components/map/map-view-config";
import type { Map as MapLibreMap, AddLayerObject } from "maplibre-gl";
import { setColorFunction } from "@geomatico/maplibre-cog-protocol";
import {
  anchorForConfig,
  foregroundRank,
  ANCHORS,
  ANCHOR_ORDER,
} from "@/components/map/map-view-config";
import {
  buildNativeLayerDefs,
  addFlatgeobufLayer,
  removeFlatgeobufLayer,
  setFlatgeobufHidden,
  addCompositeLayer,
  removeCompositeLayer,
  childrenOf,
  parseRuleKey,
  isNativeVectorFormat,
  areaFilterExpression,
  iconSpriteId,
  isHighlightLayerId,
} from "@/layers";
import { getIconFromRule } from "@/layers/geostyler";
import { loadIconBitmap } from "@/layers/icon-sprite";
import { ensureHatchImages } from "@/layers/hatch-pattern";
import { canHighlight, cachedIdProperty } from "@/layers/feature-id";
import { addGeoJsonLayer, removeGeoJsonLayer } from "@/layers/geojson-layer";
import { styleReady } from "@/layers/geojson-overlay";
import type { CompositeHost } from "@/layers";
import { buildCogColorFunction } from "@/layers/cog-style";
import { SCORE_PROTOCOL } from "@/layers/score-protocol";
import type { LayerConfig } from "@/layers";

export interface LayerEntry {
  config: LayerConfig;
}

/**
 * Source URLs that already have a COG color function registered. The
 * cog-protocol keys renderers by URL globally, so registering once per source
 * is enough (and the left / right map share the same URL).
 */
const registeredCogColorUrls = new Set<string>();

/**
 * Opacity the legend's transparency tool dims a layer to. One fixed step rather
 * than a slider: the tool is a single toggle button.
 */
export const DIMMED_OPACITY = 0.5;


/**
 * Everything `useMapLayers` hands back. One layer stack per map, so App holds
 * two of these — see `useLayerHandlers` for the per-map callback wrappers.
 */
export interface UseMapLayersResult {
  layerEntries: Accessor<LayerEntry[]>;
  hiddenIds: Accessor<Set<string>>;
  hiddenRules: Accessor<globalThis.Map<string, Set<string>>>;
  layerSteps: Accessor<globalThis.Map<string, number>>;
  playingIds: Accessor<Set<string>>;
  addLayer: (
    config: LayerConfig,
    getMap: MapAccessor,
    opts?: { atEnd?: boolean },
  ) => Promise<void>;
  removeLayer: (layerId: string, getMap: MapAccessor) => void;
  reorderLayer: (layerId: string, toIndex: number, getMap: MapAccessor) => void;
  hideLayer: (layerId: string, getMap: MapAccessor) => void;
  toggleLayer: (layerId: string, getMap: MapAccessor) => void;
  /** Ids currently dimmed by the legend's transparency tool. */
  dimmedIds: Accessor<Set<string>>;
  /** Dim a layer to DIMMED_OPACITY, or restore its configured opacity. */
  toggleDim: (layerId: string, getMap: MapAccessor) => void;
  toggleRule: (layerId: string, ruleName: string, getMap: MapAccessor) => void;
  setLayerStep: (layerId: string, value: number, getMaps: MapAccessor[]) => void;
  togglePlay: (layerId: string) => void;
  stopPlay: (layerId: string) => void;
  advanceStep: (layerId: string, getMaps: MapAccessor[]) => void;
  refreshAreaFilter: (maps?: MapAccessor[]) => void;
  syncImperativeLayers: (getMap: MapAccessor) => void;
}

export function useMapLayers(): UseMapLayersResult {
  // Signals only. The React version paired five of these with a shadowing ref,
  // because the composite host (driven by a `moveend` listener) and the
  // timeseries interval tick both run outside React and needed the current
  // value synchronously. A signal is readable from anywhere, so the mirrors —
  // and the `updateLayerEntries` wrapper that kept one of them in step — are
  // gone.
  const [layerEntries, setLayerEntries] = createSignal<LayerEntry[]>([]);
  const [hiddenIds, setHiddenIds] = createSignal<Set<string>>(new Set());
  const [hiddenRules, setHiddenRules] = createSignal<globalThis.Map<string, Set<string>>>(
    new globalThis.Map(),
  );
  const [dimmedIds, setDimmedIds] = createSignal<Set<string>>(new Set());
  // Timeseries: the step each layer currently shows, and which are playing.
  const [layerSteps, setLayerSteps] = createSignal<globalThis.Map<string, number>>(
    new globalThis.Map(),
  );
  const [playingIds, setPlayingIds] = createSignal<Set<string>>(new Set());

  /**
   * Put one config's layers on the map — the format dispatch shared by
   * addLayer (top-level entries) and the composite host (children).
   *
   * Synchronous: every remaining format is either a MapLibre source that
   * fetches its own data (mvt/pmtiles/cog), one that loads by viewport
   * (flatgeobuf), or in-memory features supplied by the host (geojson).
   */
  function dispatchFormatLoad(config: LayerConfig, getMap: MapAccessor) {
    if (config.format === "mvt" || config.format === "pmtiles") {
      // Icon-bearing layers add asynchronously (sprite load), landing at their
      // band anchor after the caller already restacked — restack again then.
      // sprite-load completion callback,
      // invoked imperatively by MapLibre; reading the stack then is exactly the point
      // eslint-disable-next-line solid/reactivity
      addMvtLayer(config, getMap, () => restackNativeLayers(layerEntries(), getMap));
    } else if (config.format === "cog") {
      addCogLayer(config, getMap);
    } else if (config.format === "flatgeobuf") {
      // Native MapLibre layers with viewport-driven bbox loading.
      addFlatgeobufLayer(config, getMap);
    } else if (config.format === "geojson") {
      // In-memory features (config.data), pushed in by the host.
      addGeoJsonLayer(config, getMap);
    }
  }

  /**
   * Loading/unloading callbacks handed to the composite manager. Children are
   * never layerEntries — they exist only as native sources on the map — so a
   * child arriving after the user hid the parent (or some of its rules) has
   * that state applied here, right after it is added.
   */
  const compositeHost: CompositeHost = {
      addChild: (child, getMap) => {
        const parentId = child.id.replace(/__c\d+$/, "");
        dispatchFormatLoad(child, getMap);

        if (hiddenIds().has(parentId)) {
          setNativeLayerVisibility(child.id, child, getMap, "none");
          if (child.format === "flatgeobuf") {
            setFlatgeobufHidden(child.id, getMap, true);
          }
        }
        // Same for a dimmed parent: the child is built from its own config, so it
        // arrives at full opacity regardless of what the parent is showing.
        if (dimmedIds().has(parentId)) {
          setNativeLayerOpacity(child, getMap, DIMMED_OPACITY);
        }
        // Replay hidden classes onto a child that loaded later. Keys of the
        // form "<childIndex>:<name>" belong to one child only; bare names apply
        // to every child (zoom-banded composites share one rule set).
        // The synthesized child id ends in `__c<index>` (validateChildConfig).
        const childIndex = Number(/__c(\d+)$/.exec(child.id)?.[1] ?? -1);
        for (const key of hiddenRules().get(parentId) ?? []) {
          const parsed = parseRuleKey(key);
          if (parsed && parsed.childIndex !== childIndex) continue;
          const bareName = parsed?.ruleName ?? key;
          setNativeRuleVisibility(child, bareName, false, getMap);
        }

        // A child loads on zoom, long after its parent's addLayer restacked, and
        // arrives at its own band anchor — restack so it takes the parent's place
        // in the array's draw order.
        restackNativeLayers(layerEntries(), getMap);
      },
      removeChild: (child, getMap) => {
        removeNativeArtifacts(child, getMap);
      },
  };

  /**
   * Put a layer on the map.
   *
   * `layerEntries` is bottom-to-top DRAW order and is the single source of truth
   * for z-order (the legend renders it reversed; reorderLayer restacks MapLibre
   * to match). A new entry is seeded to the position its `beforeid` band implies,
   * so a "foreground-layers" point layer still arrives above the default-band
   * layers already present — but only as a starting point: once placed, only
   * array position matters and a drag may move it anywhere.
   *
   * `atEnd` appends verbatim, skipping that seeding. Replay paths (share-link and
   * hash commands, annotation snapshots, the export preview) pass it because they
   * feed an already-ordered sequence: re-seeding would lift a foreground layer
   * back above a layer the user had deliberately dragged on top of it.
   */
  async function addLayer(
    config: LayerConfig,
    getMap: MapAccessor,
    opts?: { atEnd?: boolean },
  ) {
    // Inside the updater, so concurrent adds compose: several `add` commands in
    // one hash are dispatched together and each must see the others' entries.
    setLayerEntries((prev) => {
      if (prev.some((e) => e.config.id === config.id)) return prev;
      if (opts?.atEnd) return [...prev, { config }];

      // Seed above the layers this one will paint over anyway, and below any that
      // outrank it: a default-band layer goes under the foreground ones, matching
      // where restackNativeLayers puts it. Only a starting point — a drag then
      // reorders freely within the group.
      const rank = foregroundRank(config);
      let at = prev.length;
      while (at > 0 && foregroundRank(prev[at - 1].config) > rank) at--;
      return [...prev.slice(0, at), { config }, ...prev.slice(at)];
    });

    try {
      if (config.format === "composite") {
        // Children load/unload with the zoom via the composite manager.
        addCompositeLayer(config, getMap, compositeHost);
      } else {
        await dispatchFormatLoad(config, getMap);
      }
      // The native add above targeted the config's band anchor, which agrees with
      // the array position only while no drag has overridden the bands. Restack so
      // the array stays the single source of truth either way.
      restackNativeLayers(layerEntries(), getMap);
    } catch (err) {
      console.error(`Failed to load layer "${config.id}":`, err);
      setLayerEntries((prev) => prev.filter((e) => e.config.id !== config.id));
    }
  }

  function removeLayer(layerId: string, getMap: MapAccessor) {
    const entry = layerEntries().find((e) => e.config.id === layerId);

    setLayerEntries((prev) => prev.filter((e) => e.config.id !== layerId));

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
      return next;
    });

    if (!entry) return;

    // Remove native MapLibre layers and sources
    if (entry.config.format === "composite") {
      removeCompositeLayer(entry.config, getMap);
    } else {
      removeNativeArtifacts(entry.config, getMap);
    }
  }

  /**
   * Move a layer to `toIndex` in draw order (0 = bottom) and restack MapLibre to
   * match. Overrides the config's `beforeid` band: after a reorder, array
   * position alone decides what paints over what.
   */
  function reorderLayer(layerId: string, toIndex: number, getMap: MapAccessor) {
    const prev = layerEntries();
    const from = prev.findIndex((e) => e.config.id === layerId);
    if (from < 0) return;

    const without = prev.filter((_, i) => i !== from);
    // Clamp against the post-removal length, so dragging past the end lands at
    // the top instead of splicing beyond it.
    const to = Math.max(0, Math.min(toIndex, without.length));
    if (to === from) return;

    const next = [...without.slice(0, to), prev[from], ...without.slice(to)];
    setLayerEntries(next);
    restackNativeLayers(next, getMap);
  }

  function hideLayer(layerId: string, getMap: MapAccessor) {
    setHiddenIds((prev) => {
      if (prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.add(layerId);
      return next;
    });

    // Native MapLibre layers (MVT/COG/FlatGeobuf/composite children)
    const entry = layerEntries().find((e) => e.config.id === layerId);
    if (entry) {
      setEntryNativeVisibility(entry.config, getMap, "none");
    }
  }

  // The map writes sit outside the setter, not inside it. React had to run them
  // in the updater to see the post-toggle value, which made the updater impure
  // (and so double-invoked under StrictMode); a signal write lands immediately,
  // so the effect can simply follow it.
  function toggleLayer(layerId: string, getMap: MapAccessor) {
    const next = new Set(hiddenIds());
    const willBeVisible = next.has(layerId);
    if (willBeVisible) {
      next.delete(layerId);
    } else {
      next.add(layerId);
    }
    setHiddenIds(next);

    // Native MapLibre layers (MVT/COG/FlatGeobuf/composite children)
    const entry = layerEntries().find((e) => e.config.id === layerId);
    if (entry) {
      setEntryNativeVisibility(entry.config, getMap, willBeVisible ? "visible" : "none");
    }
  }

  function toggleDim(layerId: string, getMap: MapAccessor) {
    const next = new Set(dimmedIds());
    const willBeDimmed = !next.has(layerId);
    if (willBeDimmed) {
      next.add(layerId);
    } else {
      next.delete(layerId);
    }
    setDimmedIds(next);

    const entry = layerEntries().find((e) => e.config.id === layerId);
    if (entry) {
      setEntryNativeOpacity(entry.config, getMap, willBeDimmed ? DIMMED_OPACITY : null);
    }
  }

  function toggleRule(layerId: string, ruleName: string, getMap: MapAccessor) {
    const next = new globalThis.Map(hiddenRules());
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
    setHiddenRules(next);

      // `ruleName` may be a composite rule KEY ("<childIndex>:<name>"): the
      // legend keys a merged composite's classes per child, because children
      // routinely share rule names and must toggle independently. Native
      // layer ids carry the bare name, so unwrap it here.
      const parsed = parseRuleKey(ruleName);
      const bareName = parsed?.ruleName ?? ruleName;

      const entry = layerEntries().find((e) => e.config.id === layerId);
      // Children this toggle applies to: just the keyed one for a merged
      // composite, otherwise every child (zoom-banded composites duplicate
      // one rule set across children, so the name targets all of them).
      const targetChildren = entry?.config.format === "composite"
        ? parsed
          ? childrenOf(entry.config).filter((_, i) => i === parsed.childIndex)
          : childrenOf(entry.config)
        : [];

      // Native MapLibre layers (MVT/FlatGeobuf): toggle the specific rule's
      // layer. Composite: forward to the target child/children (COG children
      // no-op — their color function is global per URL).
    if (entry && isNativeVectorFormat(entry.config.format)) {
      setNativeRuleVisibility(entry.config, bareName, willBeVisible, getMap);
    } else if (entry?.config.format === "composite") {
      for (const child of targetChildren) {
        setNativeRuleVisibility(child, bareName, willBeVisible, getMap);
      }
    }
  }

  /**
   * Show a specific timeseries step for a layer, on every map it is on.
   * Rebuilds the layer's rule layers against the substituted source layer —
   * see `applyTimeseriesStep` for why remove+re-add is the only option.
   */
  function setLayerStep(layerId: string, value: number, getMaps: MapAccessor[]) {
    const entry = layerEntries().find((e) => e.config.id === layerId);
    const ts = entry?.config.timeseries;
    if (!entry || !ts) return;

    // Clamp onto the configured grid so a slider drag can't land off-step.
    const steps = Math.round((ts.end - ts.start) / ts.step);
    const index = Math.min(Math.max(Math.round((value - ts.start) / ts.step), 0), steps);
    const next = ts.start + index * ts.step;

    const hidden = {
      layerHidden: hiddenIds().has(layerId),
      hiddenRuleNames: hiddenRules().get(layerId),
    };
    for (const getMap of getMaps) {
      applyTimeseriesStep(entry.config, next, getMap, hidden);
    }

    setLayerSteps((prev) => {
      const updated = new globalThis.Map(prev);
      updated.set(layerId, next);
      return updated;
    });
  }

  /** Start/stop playback for one timeseries layer. */
  function togglePlay(layerId: string) {
    setPlayingIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }

  /** Stop playback for one layer (no-op when it isn't playing). */
  function stopPlay(layerId: string) {
    setPlayingIds((prev) => {
      if (!prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.delete(layerId);
      return next;
    });
  }

  /** Advance one step, looping back to `start` past the end. Drives playback. */
  function advanceStep(layerId: string, getMaps: MapAccessor[]) {
    const entry = layerEntries().find((e) => e.config.id === layerId);
    const ts = entry?.config.timeseries;
    if (!entry || !ts) return;
    const current = layerSteps().get(layerId) ?? ts.start;
    const next = current + ts.step > ts.end ? ts.start : current + ts.step;
    setLayerStep(layerId, next, getMaps);
  }

  /**
   * Re-apply the area filter: the selection is pushed down to each native
   * vector layer (mvt/pmtiles/flatgeobuf) as a MapLibre filter expression.
   * COG is a raster and stays unfiltered; `geojson` is host-pushed embed data
   * and is deliberately exempt (see `geojson-layer.ts`).
   *
   * The React version took a leading `_version` argument it never used, purely
   * so callers could key the call on the area filter's version counter. Callers
   * now put this in an effect that reads the filter signal instead.
   */
  function refreshAreaFilter(getMaps: MapAccessor[] = []) {
    for (const entry of layerEntries()) {
      for (const getMap of getMaps) {
        refreshNativeAreaFilter(entry.config, getMap);
      }
    }
  }

  /**
   * Re-apply imperative MVT/COG/FlatGeobuf/composite entries to a map. Used
   * when a map mounts after addLayer was already called (e.g. the right map
   * becoming ready after the first layer was added to it) and after a basemap
   * swap wipes the style. Safe to call repeatedly — the helpers skip
   * sources/layers that already exist.
   *
   * Re-added native layers default to visible (`buildNativeLayerDefs` emits an
   * empty `layout`), so hidden state has to be replayed here: unlike deck.gl
   * layers, whose `visible` prop lives in React state and survives `setStyle`,
   * a MapLibre `visibility: "none"` is wiped along with the layer it sat on.
   */
  function syncImperativeLayers(getMap: MapAccessor) {
    for (const entry of layerEntries()) {
      if (entry.config.format === "composite") {
        addCompositeLayer(entry.config, getMap, compositeHost);
      } else {
        // Same dispatch as the initial add — including `geojson`, whose
        // host-pushed features live on `config.data` and so survive the
        // style swap that wiped the source.
        dispatchFormatLoad(entry.config, getMap);
      }

      if (hiddenIds().has(entry.config.id)) {
        setEntryNativeVisibility(entry.config, getMap, "none");
      }

      // Replay the dim. The re-add above rebuilt the layer from its config, so
      // it came back at full opacity. Must stay ABOVE the `continue` below.
      if (dimmedIds().has(entry.config.id)) {
        setEntryNativeOpacity(entry.config, getMap, DIMMED_OPACITY);
      }

      // Replay hidden classes. Keys of the form "<childIndex>:<name>" belong
      // to one composite child; bare names apply to the entry itself (or, for
      // a zoom-banded composite, to every child). Mirrors addChild.
      const hiddenRuleKeys = hiddenRules().get(entry.config.id);
      if (!hiddenRuleKeys?.size) continue;

      const targets =
        entry.config.format === "composite" ? childrenOf(entry.config) : [entry.config];
      for (const key of hiddenRuleKeys) {
        const parsed = parseRuleKey(key);
        const bareName = parsed?.ruleName ?? key;
        for (const target of targets) {
          // Read the index off the synthesized `__c<index>` id rather than the
          // array position: a child dropped by validateChildConfig would shift
          // the latter out of step with the keys the legend emitted.
          if (parsed && Number(/__c(\d+)$/.exec(target.id)?.[1] ?? -1) !== parsed.childIndex) {
            continue;
          }
          setNativeRuleVisibility(target, bareName, false, getMap);
        }
      }
    }

    // Each re-add above targeted the config's `beforeid` band, which a drag may
    // have overridden — restack so the rebuilt stack matches the array order the
    // user actually set.
    restackNativeLayers(layerEntries(), getMap);
  }

  return {
    layerEntries,
    hiddenIds,
    hiddenRules,
    dimmedIds,
    layerSteps,
    playingIds,
    addLayer,
    removeLayer,
    reorderLayer,
    hideLayer,
    toggleLayer,
    toggleDim,
    toggleRule,
    setLayerStep,
    togglePlay,
    stopPlay,
    advanceStep,
    refreshAreaFilter,
    syncImperativeLayers,
  };
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
 * Source id for a native vector-tile config (MVT tile template or PMTiles
 * archive). Exported alongside {@link addMvtLayer} for `useStudyAreaLayer`,
 * which adds and removes its layer outside this hook.
 */
export function tileSourceId(config: LayerConfig): string {
  return config.format === "pmtiles"
    ? `pmtiles-source-${config.id}`
    : `mvt-source-${config.id}`;
}

/**
 * Add a native MapLibre vector-tile source + one layer per style rule.
 * Handles both MVT (a `{z}/{x}/{y}` tile template) and PMTiles (a single
 * archive read via the `pmtiles://` protocol registered in MapView).
 * Module-scope: depends only on the config and the target map.
 *
 * Exported for `useStudyAreaLayer`, which loads the configured study area
 * through its own channel (deliberately outside this hook, so it stays out of
 * the legend, picking and comparison logic) but needs the identical source +
 * rule-layer construction.
 */
export function addMvtLayer(
  config: LayerConfig,
  getMap: MapAccessor,
  /**
   * Called once icon-bearing rule layers have been added asynchronously, so the
   * caller can restack them into the array's draw order. Omit for layers that
   * must stay in their configured band (e.g. the study area).
   */
  onLate?: () => void,
): void {
  const map = getMap();
  // `styleReady`, not just `map`: the map object exists the instant MapView
  // mounts, but `addSource`/`addLayer` throw "Style is not done loading" until
  // the style JSON has arrived. Skipping is safe — the map's `load` and
  // `onLabelsReady` both call syncImperativeLayers, which replays every entry.
  if (!styleReady(map)) return;

  // A timeseries layer's configured `sourceLayer` is a template — resolve it to
  // the start step before the first addLayer, or MapLibre would be handed the
  // literal placeholder and render nothing.
  if (config.timeseries && config.sourceLayer?.includes(config.timeseries.placeholder)) {
    config.sourceLayer = timeseriesSourceLayer(config, config.timeseries.start);
  }

  const beforeId = anchorForConfig(config);
  const sourceId = tileSourceId(config);

  if (!map.getSource(sourceId)) {
    // Highlighting addresses features by id, and vector tiles carry none unless
    // the source promotes a property into that slot. `promoteId` can only be
    // set here, at creation — hence `highlightable` being a load-time config
    // field. `prefetchIdProperty` resolves it from the archive metadata before
    // the layer is added, so this stays synchronous (deferring it would reorder
    // the insert against the z-order anchors).
    const promoteId = canHighlight(config) ? cachedIdProperty(config) : undefined;

    if (config.format === "pmtiles") {
      // `url` (not `tiles`): the protocol handler reads the archive's header
      // for its own tile scheme and zoom range, so no template is needed.
      map.addSource(sourceId, {
        type: "vector",
        url: `pmtiles://${absoluteTileUrl(config.source)}`,
        ...(promoteId ? { promoteId } : {}),
      });
    } else {
      map.addSource(sourceId, {
        type: "vector",
        tiles: [absoluteTileUrl(config.source)],
        minzoom: 0,
        maxzoom: 14,
        ...(promoteId ? { promoteId } : {}),
      });
    }

  }

  // Hatch fills also need a sprite image before addLayer, but theirs is drawn
  // rather than fetched — so this stays synchronous and the layer keeps the fast
  // path below.
  ensureHatchImages(map, config);

  // Icon symbolizers need their image in the map's sprite BEFORE addLayer, and
  // loading it is async — so layers wait for it. Layers without icons keep the
  // synchronous path (registerRuleIcons returns null), since deferring them by
  // even a microtask would reorder inserts against the z-order anchors.
  const pending = registerRuleIcons(map, config);
  if (pending) {
    pending
      .catch((err) => {
        console.error(`Failed to load icon(s) for layer "${config.id}":`, err);
      })
      .then(() => {
        // The style may have been swapped (or the layer removed) while the
        // image was loading — re-check before touching the map.
        if (!map.getSource(sourceId)) return;
        addRuleLayers(map, config, sourceId, beforeId);
        // These layers arrive after the caller's restack, at their band anchor
        // rather than the array's draw position — let the caller restack now that
        // they exist. (The study-area layer passes nothing: it is chrome and must
        // stay in its own band.)
        onLate?.();
      });
    return;
  }

  addRuleLayers(map, config, sourceId, beforeId);
}

/**
 * Register every Icon symbolizer's image in the map's sprite.
 *
 * Returns null when the config has no icons (the common case) so the caller can
 * stay synchronous, or a promise that settles once all images are added.
 *
 * `hasImage` is re-checked on every call rather than cached: a basemap swap
 * wipes the sprite, and `addImage` throws on a duplicate id.
 */
function registerRuleIcons(map: MapLibreMap, config: LayerConfig): Promise<void> | null {
  const rules = config.geostyler?.rules;
  if (!rules?.length) return null;

  const work: Promise<void>[] = [];
  for (const rule of rules) {
    const icon = getIconFromRule(rule);
    if (!icon) continue;
    const spriteId = iconSpriteId(icon);
    if (map.hasImage(spriteId)) continue;

    work.push(
      // No origin prefix needed (unlike tile URLs): <img> resolves a
      // root-relative path against the document, same as the deck.gl icon path.
      loadIconBitmap(icon.image, icon.width, icon.height).then((bitmap) => {
        // Another layer (or a re-entrant add) may have registered it while we
        // were loading.
        if (map.hasImage(spriteId)) return;
        // SDF only when tinted: icon-color applies to SDF images only, and an
        // SDF image drawn untinted would lose its own colors.
        map.addImage(spriteId, bitmap, { sdf: Boolean(icon.color) });
      }),
    );
  }

  return work.length > 0 ? Promise.all(work).then(() => undefined) : null;
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
    // `layerSpec` is assembled field-by-field above, so it cannot be narrowed to
    // one arm of MapLibre's discriminated LayerSpecification union; `def.type`
    // is what actually selects the arm at runtime.
    map.addLayer(
      layerSpec as unknown as AddLayerObject,
      map.getLayer(beforeId) ? beforeId : undefined,
    );
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
function timeseriesSourceLayer(config: LayerConfig, value: number): string {
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
  getMap: MapAccessor,
  hidden: { layerHidden: boolean; hiddenRuleNames: Set<string> | undefined },
) {
  const map = getMap();
  if (!map || !config.timeseries) return;

  const nextSourceLayer = timeseriesSourceLayer(config, value);
  if (nextSourceLayer === config.sourceLayer) return;

  const defs = buildNativeLayerDefs(config);

  // Where this layer group currently sits, captured BEFORE the removal: stepping
  // must put the group back in its own slot. Re-adding at the band anchor would
  // hoist it above every layer added after it, silently changing the z-order
  // (and the legend) mid-playback. The successor is the first style layer after
  // the group that the group itself does not own.
  const ownIds = new Set(defs.map((d) => d.id));
  const styleLayers = map.getStyle()?.layers ?? [];
  const firstAt = styleLayers.findIndex((l) => ownIds.has(l.id));
  const successor =
    firstAt >= 0 ? styleLayers.slice(firstAt).find((l) => !ownIds.has(l.id))?.id : undefined;

  for (const def of defs) {
    if (map.getLayer(def.id)) map.removeLayer(def.id);
  }

  // Mutated in place: `layerEntriesRef` holds this same object, so a basemap
  // swap replays the CURRENT step rather than reverting to the start value.
  config.sourceLayer = nextSourceLayer;

  const sourceId = tileSourceId(config);
  if (!map.getSource(sourceId)) return;
  addRuleLayers(map, config, sourceId, successor ?? anchorForConfig(config));

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
function addCogLayer(config: LayerConfig, getMap: MapAccessor) {
  const map = getMap();
  // See addMvtLayer: replayed by syncImperativeLayers once the style is up.
  if (!styleReady(map)) return;

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
    // In-memory score grids ("Lagen combineren") are served by a protocol
    // registered on the MAIN thread only. A `url:` source resolves its TileJSON
    // inside the worker, which holds a SEPARATE protocol registry and so falls
    // back to a plain fetch ("URL scheme cogmem is not supported"). Naming the
    // tile template directly keeps resolution on the main thread, where the
    // protocol lives. Remote COGs keep `url:` — their TileJSON describes a real
    // file the worker can fetch.
    const isInMemory = config.source.startsWith(`${SCORE_PROTOCOL}://`);
    map.addSource(sourceId, {
      type: "raster",
      ...(isInMemory
        ? { tiles: [`${config.source}/{z}/{x}/{y}`] }
        : { url: `cog://${config.source}` }),
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

/**
 * Every native MapLibre layer id a config owns, in bottom-to-top draw order.
 *
 * One entry fans out to several native layers — one per GeoStyler rule, or a
 * fill plus a stroke for a flat-styled polygon — and that internal order is
 * meaningful (a stroke must stay above its own fill), so restacking has to move
 * the whole group as a block, in this order. A composite contributes each
 * child's layers in child order.
 *
 * Ids are returned whether or not they are currently in the style; callers that
 * touch MapLibre must still check `map.getLayer(id)`, since flatgeobuf layers
 * come and go with the viewport and composite children load by zoom.
 */
function nativeLayerIdsFor(config: LayerConfig): string[] {
  if (config.format === "composite") {
    return childrenOf(config).flatMap((child) => nativeLayerIdsFor(child));
  }
  if (config.format === "cog") return [`cog-layer-${config.id}`];
  return buildNativeLayerDefs(config).map((def) => def.id);
}

/**
 * Restack MapLibre so painting order matches `entries` (bottom-to-top).
 *
 * `entries` is the source of truth for z-order, which a drag-reorder can put in
 * conflict with each config's `beforeid` band. Rather than compute minimal moves,
 * walk the layers bottom-up and move each to a fixed anchor: every successive
 * `moveLayer` lands its layer above the previously moved one, so the final stack
 * is exactly `entries` order. Cheap next to getting the arithmetic subtly wrong,
 * and it makes the array authoritative by construction.
 *
 * The basemap's label/road overlay must keep drawing over ordinary data layers,
 * so this is done in TWO passes against two anchors, splitting the entries at
 * that overlay:
 *
 *   - `beforeid: "foreground-layers"` configs → moved before `studyarea-layers`,
 *     i.e. above the labels (and still below the study area / click marker).
 *   - everything else → moved before `overlay-layers`, i.e. below the labels.
 *
 * Within each group the array's relative order is preserved, so a drag reorders
 * freely — it just cannot lift a default-band layer over the labels. Dragging a
 * layer across the boundary changes its position among its own group; the
 * foreground/background split itself stays config-driven.
 */
function restackNativeLayers(
  entries: LayerEntry[],
  getMap: MapAccessor,
) {
  const map = getMap();
  if (!styleReady(map)) return;
  // Without the anchors there is no stable bound; a bare moveLayer would send
  // layers above the click marker. Anchors are re-created on styledata, so
  // skipping here just defers to the next restack.
  if (!map.getLayer(ANCHORS.studyarea) || !map.getLayer(ANCHORS.overlay)) return;

  // The basemap's label/road layers are inserted with `beforeId: overlay-layers`,
  // i.e. BELOW that anchor — so targeting the anchor would stack data on top of
  // them. Aim at the lowest of those overlay layers instead: the first layer above
  // `map-layers` that no entry owns. Falls back to the anchor when the overlay has
  // not loaded yet (a swap in flight), which the next restack corrects.
  const style = map.getStyle()?.layers ?? [];
  const owned = new Set(entries.flatMap((e) => nativeLayerIdsFor(e.config)));
  const anchorIds = new Set<string>(ANCHOR_ORDER);
  const mapAt = style.findIndex((l) => l.id === ANCHORS.map);
  const overlayAt = style.findIndex((l) => l.id === ANCHORS.overlay);
  let belowLabels: string = ANCHORS.overlay;
  for (let i = mapAt + 1; i < overlayAt; i++) {
    const id = style[i].id;
    if (owned.has(id) || anchorIds.has(id)) continue;
    belowLabels = id;
    break;
  }

  const isForeground = (entry: LayerEntry) =>
    anchorForConfig(entry.config) === ANCHORS.foreground;

  // Below the labels first, then above them — each pass bottom-up.
  for (const [group, anchor] of [
    [entries.filter((e) => !isForeground(e)), belowLabels],
    [entries.filter(isForeground), ANCHORS.studyarea],
  ] as const) {
    for (const entry of group) {
      for (const id of nativeLayerIdsFor(entry.config)) {
        if (!map.getLayer(id)) continue;
        map.moveLayer(id, anchor);
      }
    }
  }
}

/** Set visibility on all native MapLibre layers belonging to a config */
function setNativeLayerVisibility(
  configId: string,
  config: LayerConfig,
  getMap: MapAccessor,
  visibility: "visible" | "none",
) {
  const map = getMap();
  if (!styleReady(map)) return;

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

/** The opacity paint property for each native layer type. */
const OPACITY_PAINT_KEY: Record<string, string> = {
  fill: "fill-opacity",
  line: "line-opacity",
  circle: "circle-opacity",
  symbol: "icon-opacity",
  raster: "raster-opacity",
  "fill-extrusion": "fill-extrusion-opacity",
  heatmap: "heatmap-opacity",
};

/**
 * Dim a config's native layers to `dimmed`, or restore their configured opacity
 * when `dimmed` is null.
 *
 * The default is recovered by rebuilding the layer defs rather than snapshotting
 * what was on the map: `buildNativeLayerDefs` is pure, and opacity is per-RULE
 * (`ruleOpacity` — a symbolizer's own opacity outranks the layer's `style.opacity`).
 * A single remembered number would flatten that and reset every rule to the same
 * value, so a layer whose rules differ in opacity would come back wrong.
 *
 * A fill's outline is a separate paint property with its own configured value, so
 * it is dimmed alongside the fill — otherwise dimming a polygon leaves a
 * full-strength outline behind.
 */
function setNativeLayerOpacity(
  config: LayerConfig,
  getMap: MapAccessor,
  dimmed: number | null,
) {
  const map = getMap();
  if (!styleReady(map)) return;

  // COG opacity is baked into the per-pixel colour function, not a paint
  // property, so there is nothing to set here.
  if (config.format === "cog") return;
  if (!isNativeVectorFormat(config.format)) return;

  for (const def of buildNativeLayerDefs(config)) {
    if (!map.getLayer(def.id)) continue;
    // The highlight outline is not part of the layer's own styling — dimming
    // the data must not fade the marker pointing at the feature you clicked.
    // Its opacity is a feature-state expression; writing a number here would
    // also overwrite that expression and leave the outline permanently on.
    if (isHighlightLayerId(def.id)) continue;
    const key = OPACITY_PAINT_KEY[def.type];
    if (!key) continue;
    // setPaintProperty's key/value types are a union over every layer type, which
    // a runtime-selected key cannot satisfy. OPACITY_PAINT_KEY pairs each type
    // with its own opacity property, so the pair is correct by construction.
    const setPaint = map.setPaintProperty.bind(map) as (
      layerId: string,
      name: string,
      value: unknown,
    ) => void;
    setPaint(def.id, key, dimmed ?? def.paint[key] ?? 1);
    // Keep a polygon's outline in step with its fill.
    if (def.type === "fill" && def.paint["fill-outline-color"] !== undefined) {
      const outline = def.paint["fill-outline-color"];
      setPaint(def.id, "fill-outline-color", dimmed === null ? outline : withAlpha(outline, dimmed));
    }
  }
}

/**
 * Apply `alpha` to a colour string for the fill-outline case, which has no
 * separate opacity property. Returns the input unchanged when it is not a form we
 * can rewrite — a dimmed outline is cosmetic, so leaving it alone beats throwing.
 */
function withAlpha(color: unknown, alpha: number): unknown {
  if (typeof color !== "string") return color;
  if (color === "transparent") return color;
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

/** Dim/restore every native layer of an entry, following composite children. */
function setEntryNativeOpacity(
  config: LayerConfig,
  getMap: MapAccessor,
  dimmed: number | null,
) {
  const targets = config.format === "composite" ? childrenOf(config) : [config];
  for (const target of targets) {
    setNativeLayerOpacity(target, getMap, dimmed);
  }
}

/**
 * Remove the native MapLibre sources/layers a config created. Module-scope;
 * shared by removeLayer (top-level entries) and the composite host (children).
 */
function removeNativeArtifacts(config: LayerConfig, getMap: MapAccessor) {
  const map = getMap();
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
    removeFlatgeobufLayer(config, getMap);
  } else if (config.format === "geojson") {
    removeGeoJsonLayer(config, getMap);
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
  getMap: MapAccessor,
) {
  const map = getMap();
  if (!styleReady(map)) return;
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
  getMap: MapAccessor,
) {
  if (!isNativeVectorFormat(config.format)) return;
  const map = getMap();
  if (!styleReady(map)) return;
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
  getMap: MapAccessor,
  visibility: "visible" | "none",
) {
  const targets = config.format === "composite" ? childrenOf(config) : [config];
  for (const target of targets) {
    setNativeLayerVisibility(target.id, target, getMap, visibility);
    if (target.format === "flatgeobuf") {
      setFlatgeobufHidden(target.id, getMap, visibility === "none");
    }
  }
}

