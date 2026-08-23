import type { LayerEntry } from "@/hooks/use-map-layers";
import { DEFAULT_BASEMAP_ID } from "@/components/map/map-view-config";
import { VARIANT_PARAM, variantId } from "@/config/variant";
import {
  MAP_SIDES,
  forSide,
  sideToWire,
  type MapSideId,
  type MapSidePair,
} from "@/lib/map-side";

/** What one map contributes to a share link. */
export interface ShareUrlSide {
  entries: LayerEntry[];
  hiddenIds: Set<string>;
}

/**
 * State serialized into a share URL. Mirrors (in reverse) what
 * use-url-commands.ts parses from the URL hash, so a generated link
 * round-trips through the existing command pipeline.
 */
export interface ShareUrlState {
  viewState: { longitude: number; latitude: number; zoom: number };
  sides: MapSidePair<ShareUrlSide>;
  /**
   * Collaborative annotation room id (UUID). When set, the link carries an
   * `annot` param: recipients auto-enter annotation mode and join the room.
   */
  annotRoomId?: string | null;
  /**
   * Selected basemap. Emitted only when it differs from the default, so ordinary
   * links stay short.
   */
  basemapId?: string;
}

/**
 * A layer can only be re-added by id when it exists in layers.json. In-memory
 * embed datasets (Power BI `map-data`, format "geojson" with inline `data`)
 * are excluded — the recipient's app can't resolve them. (Annotation
 * snapshots apply the same rule.)
 */
export function isUrlAddressable(entry: LayerEntry): boolean {
  return !(entry.config.format === "geojson" && entry.config.data);
}

/**
 * Build a shareable URL that reproduces the current map session: view
 * (center/zoom) plus `add` commands for every layer on both maps and `hide`
 * commands for the hidden ones, in the exact hash format parseCommands /
 * parseView in use-url-commands.ts understand. Per-rule hides are not
 * URL-representable (there is no rule command) and are dropped.
 */
export function buildShareUrl(state: ShareUrlState, base?: string): string {
  const params = new URLSearchParams();
  params.set("zoom", state.viewState.zoom.toFixed(2));
  params.set(
    "center",
    `${state.viewState.longitude.toFixed(5)},${state.viewState.latitude.toFixed(5)}`,
  );
  if (state.annotRoomId) params.set("annot", state.annotRoomId);
  if (state.basemapId && state.basemapId !== DEFAULT_BASEMAP_ID) {
    params.set("basemap", state.basemapId);
  }

  // The active config variant, when the project has any. Read from the module
  // rather than taken as state: layer ids are reused between variants, so a
  // link without it would reopen the same ids against whichever variant the
  // recipient happens to land on and show a different year's data under the
  // right names. Omitted entirely for projects with no variants, keeping their
  // links byte-identical to before.
  const variant = variantId();
  if (variant) params.set(VARIANT_PARAM, variant);

  // The parser index-aligns getAll("cmd")/getAll("map")/getAll("layer"), so
  // every command must append all three keys.
  const appendCommand = (cmd: "add" | "hide", side: MapSideId, layer: string) => {
    params.append("cmd", cmd);
    params.append("map", sideToWire(side));
    params.append("layer", layer);
  };

  for (const side of MAP_SIDES) {
    const { entries, hiddenIds } = forSide(state.sides, side);
    for (const entry of entries) {
      if (!isUrlAddressable(entry)) continue;
      appendCommand("add", side, entry.config.id);
      if (hiddenIds.has(entry.config.id)) {
        appendCommand("hide", side, entry.config.id);
      }
    }
  }

  const origin = base ?? window.location.origin + window.location.pathname;
  return `${origin}#${params.toString()}`;
}
