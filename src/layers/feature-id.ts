import { PMTiles } from "pmtiles";
import type { LayerConfig } from "./types";

/**
 * Feature identity for highlighting.
 *
 * MapLibre's `setFeatureState` addresses a feature by `{source, sourceLayer,
 * id}`, and vector tiles carry no `id` unless the source was created with
 * `promoteId` naming a property to lift into that slot. Without it the call
 * silently does nothing — no error, no paint — so a layer that cannot resolve
 * an id property must be reported rather than left looking merely broken.
 */

/** Default highlight outline colour: red, high contrast on the map palettes. */
export const HIGHLIGHT_COLOR = "#FF0000";

/** Width in px of the highlight outline when a feature is hovered/selected. */
export const HIGHLIGHT_WIDTH = 2;

/** Default casing colour: white, to lift the outline off the basemap. */
export const HIGHLIGHT_CASING_COLOR = "#FFFFFF";

/** Casing visible on EACH side of the outline. */
export const HIGHLIGHT_CASING_PAD = 1;

/**
 * Total width of the casing line. Derived rather than written as a literal
 * because the pad — how much casing shows on each side — is the thing being
 * chosen; retuning HIGHLIGHT_WIDTH then keeps that pad true instead of
 * silently changing it.
 */
export const HIGHLIGHT_CASING_WIDTH = HIGHLIGHT_WIDTH + 2 * HIGHLIGHT_CASING_PAD;

/**
 * Properties tried, in order, when a highlightable layer names no
 * `idProperty`. Most specific first: the CBS codes are unique per feature,
 * while a bare `id`/`fid` is only a good guess once those have missed.
 */
const ID_CANDIDATES = [
  "bu_code",
  "wk_code",
  "gm_code",
  "id",
  "fid",
  "objectid",
] as const;

/**
 * Field lists per PMTiles archive URL, keyed by source-layer name.
 * One archive backs many configs (20 archives for ~200 layers here), so this is
 * cached per URL and the promise is shared by concurrent callers.
 */
const archiveFields = new Map<string, Promise<Map<string, string[]>>>();

interface PmtilesVectorLayer {
  id?: string;
  fields?: Record<string, unknown>;
}

/**
 * Read `vector_layers[].fields` out of a PMTiles archive's metadata.
 *
 * This is why detection can happen at all: `promoteId` is fixed when the source
 * is created and cannot be set later (verified — `setPromoteId` does not exist,
 * and mutating the option then reloading leaves `feature.id` undefined), so the
 * id property has to be known *before* `addSource`. Sampling a rendered feature
 * would be too late. The metadata is a single cached range read on the header.
 */
async function fieldsForArchive(url: string): Promise<Map<string, string[]>> {
  const cached = archiveFields.get(url);
  if (cached) return cached;

  const pending = (async () => {
    const out = new Map<string, string[]>();
    // Network + parse of a third-party file: a failure here must only cost the
    // highlight, never the layer, so it degrades to "no id property found".
    try {
      const metadata = (await new PMTiles(url).getMetadata()) as {
        vector_layers?: PmtilesVectorLayer[];
      };
      for (const layer of metadata.vector_layers ?? []) {
        if (layer.id) out.set(layer.id, Object.keys(layer.fields ?? {}));
      }
    } catch (err) {
      console.warn(`Could not read PMTiles metadata for highlighting (${url}):`, err);
    }
    return out;
  })();

  archiveFields.set(url, pending);
  return pending;
}

/**
 * The property to promote to `feature.id` for `config`, or null when none can
 * be found.
 *
 * An explicit `idProperty` wins and is returned without any network read.
 * Otherwise the archive's declared fields are matched against ID_CANDIDATES.
 */
export async function resolveIdProperty(config: LayerConfig): Promise<string | null> {
  if (config.idProperty) return config.idProperty;
  if (config.format !== "pmtiles") return null;

  const byLayer = await fieldsForArchive(archiveUrlFor(config.source));
  // The config names its source layer; fall back to the sole layer when an
  // archive contains exactly one, which is the common case here.
  const fields =
    (config.sourceLayer ? byLayer.get(config.sourceLayer) : undefined) ??
    (byLayer.size === 1 ? [...byLayer.values()][0] : undefined);

  if (!fields) return null;

  for (const candidate of ID_CANDIDATES) {
    if (fields.includes(candidate)) return candidate;
  }

  console.warn(
    `layers.json: layer "${config.id}" is highlightable but no id property could be ` +
      `resolved (tried ${ID_CANDIDATES.join(", ")}). Set "idProperty" to the field ` +
      "holding a unique feature id; highlighting is disabled for this layer.",
  );
  return null;
}

/**
 * The archive URL to read metadata from, resolved the same way the map source
 * resolves it (see absoluteTileUrl in use-map-layers): a root-relative path is
 * prefixed with the current origin so layers.json can stay origin-agnostic.
 * Duplicated rather than imported to keep this module free of a hook cycle.
 */
function archiveUrlFor(source: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
  if (source.startsWith("/")) return window.location.origin + source;
  return source;
}

/** Resolved id property per config id, once `prefetchIdProperty` has settled. */
const idPropertyByConfig = new Map<string, string | null>();

/**
 * Resolve and cache `config`'s id property so `cachedIdProperty` can answer
 * synchronously when the layer is added.
 *
 * Layer insertion is synchronous on purpose — deferring it by even a microtask
 * reorders the insert against the z-order anchors — so the async metadata read
 * has to happen before, not during.
 */
export async function prefetchIdProperty(config: LayerConfig): Promise<string | null> {
  if (!canHighlight(config)) return null;
  const cached = idPropertyByConfig.get(config.id);
  if (cached !== undefined) return cached;

  const property = await resolveIdProperty(config);
  idPropertyByConfig.set(config.id, property);
  return property;
}

/**
 * The id property resolved earlier by `prefetchIdProperty`, or undefined when
 * it has not resolved yet. Synchronous, for use at `addSource` time.
 */
export function cachedIdProperty(config: LayerConfig): string | undefined {
  if (config.idProperty) return config.idProperty;
  return idPropertyByConfig.get(config.id) ?? undefined;
}

/** Forget cached archive metadata (used by tests and on hard reload). */
export function clearIdPropertyCache(): void {
  archiveFields.clear();
  idPropertyByConfig.clear();
}

/**
 * Whether `config` can carry a highlight: opted in, and on a format whose
 * features have stable ids.
 *
 * GeoJSON-backed layers are excluded deliberately. `generateId` would give them
 * ids, but those are positional and are reassigned on every `setData` — and
 * flatgeobuf refetches per moveend — so a held id would drift onto a different
 * feature.
 */
export function canHighlight(config: LayerConfig): boolean {
  if (!config.highlightable) return false;
  return config.format === "mvt" || config.format === "pmtiles";
}
