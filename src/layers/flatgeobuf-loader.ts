import { deserialize } from "flatgeobuf/lib/mjs/geojson.js";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { Feature } from "geojson";
import type { MapAccessor } from "@/components/map/map-view-config";
import type { LayerConfig } from "./types";
import { buildNativeLayerDefs } from "./mvt-style";
import { ensureHatchImages } from "./hatch-pattern";
import { styleReady } from "./geojson-overlay";
import { anchorForConfig } from "@/components/map/map-view-config";

/**
 * FlatGeobuf layers: native MapLibre GeoJSON source + layers, fed by
 * bbox-filtered HTTP Range reads against the file's packed Hilbert R-tree
 * index (only features intersecting the viewport are downloaded). The source
 * is refreshed on every `moveend`, gated by a per-layer `minzoom` — below it
 * nothing is fetched or shown, since a zoomed-out viewport bbox would cover
 * the entire dataset.
 *
 * Unlike the parquet/geoarrow loaders there is no permanent URL-keyed table
 * cache: what's loaded depends on the camera, so state lives in per-(map,
 * config) sessions instead. The WeakMap keying handles the left/right compare
 * maps and the export-preview map without extra wiring — every lifecycle
 * caller already passes its own getMap.
 */

/** Default zoom cutoff when the config doesn't specify `minzoom`. */
const FGB_DEFAULT_MINZOOM = 12;

/**
 * Viewport padding per side, as a fraction of the viewport span. Fetching
 * slightly beyond the viewport lets small pans stay inside the last-fetched
 * area (no request at all) and pre-loads the features a pan reveals.
 */
const BBOX_PAD = 0.25;

/** Progressive render: push collected features to the source every N features. */
const SETDATA_CHUNK = 2000;

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface FgbSession {
  config: LayerConfig;
  map: MapLibreMap;
  /** Bumped on every refetch/teardown; an in-flight iteration that sees a newer generation stops. */
  generation: number;
  /** PADDED bbox of the last completed fetch; viewports inside it skip refetching. */
  lastFetchedBbox: Rect | null;
  /** Last delivered feature set — seeds the re-added source after a basemap swap. */
  features: Feature[];
  /** Hidden via the legend: pause refetching (visibility is handled by the caller). */
  hidden: boolean;
  /** Bound moveend listener, kept so removal can unsubscribe it. */
  onMoveEnd: () => void;
}

/** Per-map session registry; a map's entry disappears with the map itself. */
const sessions = new WeakMap<MapLibreMap, globalThis.Map<string, FgbSession>>();

function sessionFor(map: MapLibreMap, configId: string): FgbSession | undefined {
  return sessions.get(map)?.get(configId);
}

/** Same origin-prefixing as absoluteTileUrl in use-map-layers: the flatgeobuf
 * reader needs an absolute URL to issue range requests against. */
function absoluteUrl(source: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
  if (source.startsWith("/")) return window.location.origin + source;
  return source;
}

function viewportRect(map: MapLibreMap): Rect {
  const bounds = map.getBounds();
  return {
    minX: Math.max(-180, bounds.getWest()),
    minY: bounds.getSouth(),
    maxX: Math.min(180, bounds.getEast()),
    maxY: bounds.getNorth(),
  };
}

function padRect(rect: Rect): Rect {
  const padX = (rect.maxX - rect.minX) * BBOX_PAD;
  const padY = (rect.maxY - rect.minY) * BBOX_PAD;
  return {
    minX: Math.max(-180, rect.minX - padX),
    minY: Math.max(-90, rect.minY - padY),
    maxX: Math.min(180, rect.maxX + padX),
    maxY: Math.min(90, rect.maxY + padY),
  };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.minY >= outer.minY &&
    inner.maxX <= outer.maxX &&
    inner.maxY <= outer.maxY
  );
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Push features to the layer's GeoJSON source — only if the result is still
 * current (generation unchanged) and the source still exists (it can be gone
 * mid basemap swap; syncImperativeLayers restores it afterwards).
 */
function safeSetData(session: FgbSession, generation: number, features: Feature[]): void {
  if (generation !== session.generation) return;
  const source = session.map.getSource(`fgb-source-${session.config.id}`) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData({ type: "FeatureCollection", features });
}

/**
 * Fetch the features for the current viewport and hand them to the source.
 * Skips when zoomed out below `minzoom` (clearing anything shown) or when the
 * viewport is still inside the last fetch's padded bbox. A refetch bumps the
 * session generation, which makes any still-running previous iteration stop
 * consuming — abandoning the async iterator stops its sequential range
 * requests — and guarantees its stale results never reach the source.
 */
async function refetch(session: FgbSession): Promise<void> {
  const { map, config } = session;
  const minzoom = config.minzoom ?? FGB_DEFAULT_MINZOOM;

  if (map.getZoom() < minzoom) {
    session.generation++;
    if (session.features.length > 0 || session.lastFetchedBbox) {
      session.features = [];
      session.lastFetchedBbox = null;
      const source = map.getSource(`fgb-source-${config.id}`) as GeoJSONSource | undefined;
      source?.setData(EMPTY_FC);
    }
    return;
  }

  const viewport = viewportRect(map);
  if (session.lastFetchedBbox && contains(session.lastFetchedBbox, viewport)) return;

  const padded = padRect(viewport);
  const generation = ++session.generation;
  const collected: Feature[] = [];

  try {
    for await (const feature of deserialize(absoluteUrl(config.source), padded)) {
      if (generation !== session.generation) return; // superseded — stop consuming
      // The fgb iterator yields features without ids; assign sequential ones so
      // feature picking can tell equal-properties features apart.
      const f = feature as Feature;
      f.id = collected.length;
      collected.push(f);
      if (collected.length % SETDATA_CHUNK === 0) safeSetData(session, generation, collected);
    }
    if (generation !== session.generation) return;
    session.features = collected;
    session.lastFetchedBbox = padded;
    safeSetData(session, generation, collected);
  } catch (err) {
    console.error(`Failed to load flatgeobuf layer "${config.id}":`, err);
  }
}

/**
 * Add the native source + rule layers for a flatgeobuf config to a map and
 * start viewport-driven loading. Idempotent: `addLayer` calls it once, and
 * `syncImperativeLayers` calls it repeatedly (after basemap swaps, late map
 * mounts) — existing sources/layers are kept, a missing source is re-created
 * seeded with the session's features so a style swap restores instantly.
 */
export function addFlatgeobufLayer(config: LayerConfig, getMap: MapAccessor): void {
  const map = getMap();
  // See addMvtLayer: replayed by syncImperativeLayers once the style is up.
  if (!styleReady(map)) return;

  const beforeId = anchorForConfig(config);
  const sourceId = `fgb-source-${config.id}`;
  let session = sessionFor(map, config.id);

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "geojson",
      data: { type: "FeatureCollection", features: session?.features ?? [] },
    });
  }

  // Any hatched rule needs its pattern image in the sprite before addLayer.
  ensureHatchImages(map, config);

  const minzoom = config.minzoom ?? FGB_DEFAULT_MINZOOM;
  for (const def of buildNativeLayerDefs(config)) {
    if (map.getLayer(def.id)) continue;

    const layerSpec: Record<string, unknown> = {
      id: def.id,
      source: sourceId,
      type: def.type,
      paint: def.paint,
      // minzoom on the layer spec makes features vanish exactly at the cutoff,
      // even before the refetch clears the source data.
      minzoom,
      // maxzoom only for composite children with an upper bound.
      ...(config.maxzoom !== undefined ? { maxzoom: config.maxzoom } : {}),
      layout: {
        ...def.layout,
        ...(session?.hidden ? { visibility: "none" } : {}),
      },
    };
    if (def.filter) {
      layerSpec.filter = def.filter;
    }

    // Same fallback as addMvtLayer: native addLayer throws on a missing
    // beforeId — append instead; imperative layers are re-synced once the
    // anchors exist.
    map.addLayer(layerSpec as never, map.getLayer(beforeId) ? beforeId : undefined);
  }

  if (!session) {
    const newSession: FgbSession = {
      config,
      map,
      generation: 0,
      lastFetchedBbox: null,
      features: [],
      hidden: false,
      onMoveEnd: () => {
        if (!newSession.hidden) void refetch(newSession);
      },
    };
    session = newSession;
    let byId = sessions.get(map);
    if (!byId) {
      byId = new globalThis.Map();
      sessions.set(map, byId);
    }
    byId.set(config.id, session);
    // The listener lives on the Map object, not the style, so it survives
    // basemap setStyle() — it is registered exactly once per (map, config).
    map.on("moveend", session.onMoveEnd);
  }

  // Initial load — and on re-syncs a cheap no-op unless the camera moved
  // beyond the padded bbox while the source was gone.
  if (!session.hidden) void refetch(session);
}

/** Stop viewport-driven loading and remove the layer's source + layers. */
export function removeFlatgeobufLayer(config: LayerConfig, getMap: MapAccessor): void {
  const map = getMap();
  if (!map) return;

  const session = sessionFor(map, config.id);
  if (session) {
    session.generation++; // cancel any in-flight iteration
    map.off("moveend", session.onMoveEnd);
    sessions.get(map)?.delete(config.id);
  }

  for (const def of buildNativeLayerDefs(config)) {
    if (map.getLayer(def.id)) map.removeLayer(def.id);
  }
  const sourceId = `fgb-source-${config.id}`;
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/**
 * Pause/resume viewport-driven loading when the layer is hidden/shown via the
 * legend. Layer visibility itself is applied by setNativeLayerVisibility; this
 * only stops hidden layers from refetching, and catches up on unhide (the
 * camera may have moved while hidden).
 */
export function setFlatgeobufHidden(
  configId: string,
  getMap: MapAccessor,
  hidden: boolean,
): void {
  const map = getMap();
  if (!map) return;
  const session = sessionFor(map, configId);
  if (!session || session.hidden === hidden) return;
  session.hidden = hidden;
  if (!hidden) void refetch(session);
}
