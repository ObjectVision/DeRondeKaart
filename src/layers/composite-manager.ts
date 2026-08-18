import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapAccessor } from "@/components/map/map-view-config";
import type { FeatureInfoConfig, GeoStylerRule, LayerConfig } from "./types";
import { styleReady } from "./geojson-overlay";

/**
 * "composite" layers: one layers.json entry composed of inline child layer
 * configs, each active only while the map zoom is inside its
 * `[minzoom, maxzoom)` range (defaults 0/24). The composite is the single
 * navigation/legend/share entry; children are loaded/unloaded behind it as
 * the user zooms — e.g. a COG raster overview below zoom 12 handing over to a
 * FlatGeobuf polygon layer above it.
 *
 * The manager owns per-(map, parentId) sessions (same registry pattern as
 * flatgeobuf-loader) and watches `moveend` to reconcile which children are
 * loaded. Actually loading/unloading a child is delegated to a
 * `CompositeHost` provided by useMapLayers — deck-rendered child formats
 * (parquet/geoarrow) need the hook's state setters, which module-scope code
 * can't reach.
 */

/** Loading/unloading callbacks implemented by useMapLayers. */
export interface CompositeHost {
  /**
   * Load one child (dispatch on its format) and apply the parent's current
   * hidden/rule-visibility state to whatever it created.
   */
  addChild(config: LayerConfig, getMap: MapAccessor): void;
  /** Remove a child's native sources/layers. */
  removeChild(config: LayerConfig, getMap: MapAccessor): void;
}

interface CompositeSession {
  parent: LayerConfig;
  map: MapLibreMap;
  getMap: MapAccessor;
  host: CompositeHost;
  /** Ids of children currently dispatched (marked before the async load resolves). */
  loaded: Set<string>;
  /** Bound moveend listener; lives on the Map object so it survives setStyle. */
  onMoveEnd: () => void;
}

/** Per-map session registry; a map's entry disappears with the map itself. */
const sessions = new WeakMap<MapLibreMap, globalThis.Map<string, CompositeSession>>();

export function isComposite(config: LayerConfig): boolean {
  return config.format === "composite";
}

export function childrenOf(config: LayerConfig): LayerConfig[] {
  return config.layers ?? [];
}

/** One legend row contributed by a composite child. */
export interface CompositeRuleRef {
  childId: string;
  childIndex: number;
  rule: GeoStylerRule;
  /**
   * Collision-free rule identity, `"<childIndex>:<ruleName>"`. Children of a
   * merged composite routinely share rule names (every loopafstand COG uses the
   * same six class names), so the legend and `hiddenRules` must key on the
   * child too or one click would toggle several children at once.
   */
  key: string;
  /** False for COG children: their classes are a read-only color key. */
  interactive: boolean;
}

/** Split a rule key back into its child index and bare rule name. */
export function parseRuleKey(key: string): { childIndex: number; ruleName: string } | null {
  const sep = key.indexOf(":");
  if (sep <= 0) return null;
  const childIndex = Number(key.slice(0, sep));
  if (!Number.isInteger(childIndex) || childIndex < 0) return null;
  return { childIndex, ruleName: key.slice(sep + 1) };
}

/**
 * The legend rows a composite contributes, in child order — used when the
 * composite declares no `geostyler` of its own, i.e. children render
 * simultaneously (no zoom bands) and each shows its own classes.
 *
 * Composites that DO declare a geostyler keep the original behaviour: their
 * children are zoom-banded alternatives that duplicate one rule set, so the
 * parent's rules are the legend and this returns nothing.
 */
export function compositeLegendRules(parent: LayerConfig): CompositeRuleRef[] {
  if (!isComposite(parent) || parent.geostyler) return [];

  const refs: CompositeRuleRef[] = [];
  childrenOf(parent).forEach((child, childIndex) => {
    for (const rule of child.geostyler?.rules ?? []) {
      refs.push({
        childId: child.id,
        childIndex,
        rule,
        key: `${childIndex}:${rule.name}`,
        // A COG is styled per-pixel by a color function registered globally per
        // source URL, so single classes can't be hidden.
        interactive: child.format !== "cog",
      });
    }
  });
  return refs;
}

/** Child load range: `minzoom <= zoom < maxzoom` (MapLibre convention). */
export function childInRange(child: LayerConfig, zoom: number): boolean {
  return (child.minzoom ?? 0) <= zoom && zoom < (child.maxzoom ?? 24);
}

/**
 * True when a composite child's load state is (also) enforced natively by
 * MapLibre — these need an idempotent re-add after a basemap swap wipes the
 * style, exactly like syncImperativeLayers does for standalone entries.
 */
function isNativeFormat(config: LayerConfig): boolean {
  return (
    config.format === "mvt" ||
    config.format === "cog" ||
    config.format === "flatgeobuf" ||
    config.format === "pmtiles"
  );
}

function sessionFor(map: MapLibreMap, parentId: string): CompositeSession | undefined {
  return sessions.get(map)?.get(parentId);
}

/**
 * Reconcile a composite's children against the current zoom: load children
 * entering their range, unload children leaving it, and (idempotently) re-add
 * native children whose sources/layers a basemap swap may have wiped.
 */
function sync(session: CompositeSession): void {
  const zoom = session.map.getZoom();
  for (const child of childrenOf(session.parent)) {
    const inRange = childInRange(child, zoom);
    const loaded = session.loaded.has(child.id);
    if (inRange && !loaded) {
      // Mark first so a re-entrant sync doesn't double-load; unmark on failure
      // so the next zoom-in retries.
      session.loaded.add(child.id);
      try {
        session.host.addChild(child, session.getMap);
      } catch (err) {
        session.loaded.delete(child.id);
        console.error(`Failed to load composite child "${child.id}":`, err);
      }
    } else if (inRange && loaded && isNativeFormat(child)) {
      // Idempotent native re-add (skips sources/layers that already exist).
      try {
        session.host.addChild(child, session.getMap);
      } catch (err) {
        console.error(`Failed to re-sync composite child "${child.id}":`, err);
      }
    } else if (!inRange && loaded) {
      session.loaded.delete(child.id);
      session.host.removeChild(child, session.getMap);
    }
  }
}

/**
 * Register a composite on a map: create the session, arm the moveend watcher,
 * and load the children in range. Idempotent — `addLayer` calls it once and
 * `syncImperativeLayers` repeatedly (basemap swaps, late map mounts); an
 * existing session just reconciles.
 */
export function addCompositeLayer(
  parent: LayerConfig,
  getMap: MapAccessor,
  host: CompositeHost,
): void {
  const map = getMap();
  // Also not while the style is still loading: the children this session adds
  // go through the same addSource path. syncImperativeLayers re-invokes it.
  if (!styleReady(map)) return;

  let session = sessionFor(map, parent.id);
  if (!session) {
    const newSession: CompositeSession = {
      parent,
      map,
      getMap,
      host,
      loaded: new Set(),
      onMoveEnd: () => sync(newSession),
    };
    session = newSession;
    let byId = sessions.get(map);
    if (!byId) {
      byId = new globalThis.Map();
      sessions.set(map, byId);
    }
    byId.set(parent.id, session);
    map.on("moveend", session.onMoveEnd);
  }
  sync(session);
}

/** Tear down: stop watching zoom and unload every loaded child. */
export function removeCompositeLayer(parent: LayerConfig, getMap: MapAccessor): void {
  const map = getMap();
  if (!map) return;
  const session = sessionFor(map, parent.id);
  if (!session) return;

  map.off("moveend", session.onMoveEnd);
  sessions.get(map)?.delete(parent.id);
  for (const child of childrenOf(parent)) {
    if (session.loaded.has(child.id)) {
      session.host.removeChild(child, getMap);
    }
  }
  session.loaded.clear();
}

/**
 * A flattened, map-queryable view of a layer entry: for a composite, one
 * pseudo-entry per child whose `config` is the child (its formats/ids match
 * what is actually on the map) but whose owner fields are the PARENT's — picks
 * report the parent id/name and popups use the parent's featureinfo.
 */
export interface PickableEntry {
  config: LayerConfig;
  ownerId: string;
  ownerName: string;
  featureinfo?: FeatureInfoConfig;
  excludeFromPicking?: boolean;
}

export function expandForMapQueries(entries: { config: LayerConfig }[]): PickableEntry[] {
  const out: PickableEntry[] = [];
  for (const { config } of entries) {
    if (isComposite(config)) {
      for (const child of childrenOf(config)) {
        out.push({
          config: child,
          ownerId: config.id,
          ownerName: config.name,
          featureinfo: config.featureinfo,
          excludeFromPicking: config.excludeFromPicking,
        });
      }
    } else {
      out.push({
        config,
        ownerId: config.id,
        ownerName: config.name,
        featureinfo: config.featureinfo,
        excludeFromPicking: config.excludeFromPicking,
      });
    }
  }
  return out;
}
