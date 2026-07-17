import type { LayerEntry } from "@/hooks/use-map-layers";

/**
 * State serialized into a share URL. Mirrors (in reverse) what
 * use-url-commands.ts parses from the URL hash, so a generated link
 * round-trips through the existing command pipeline.
 */
export interface ShareUrlState {
  viewState: { longitude: number; latitude: number; zoom: number };
  entriesA: LayerEntry[];
  entriesB: LayerEntry[];
  hiddenIdsA: Set<string>;
  hiddenIdsB: Set<string>;
  /**
   * Collaborative annotation room id (UUID). When set, the link carries an
   * `annot` param: recipients auto-enter annotation mode and join the room.
   */
  annotRoomId?: string | null;
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

  // The parser index-aligns getAll("cmd")/getAll("map")/getAll("layer"), so
  // every command must append all three keys.
  const appendCommand = (cmd: "add" | "hide", map: "a" | "b", layer: string) => {
    params.append("cmd", cmd);
    params.append("map", map);
    params.append("layer", layer);
  };

  const sides: Array<{ map: "a" | "b"; entries: LayerEntry[]; hidden: Set<string> }> = [
    { map: "a", entries: state.entriesA, hidden: state.hiddenIdsA },
    { map: "b", entries: state.entriesB, hidden: state.hiddenIdsB },
  ];
  for (const side of sides) {
    for (const entry of side.entries) {
      if (!isUrlAddressable(entry)) continue;
      appendCommand("add", side.map, entry.config.id);
      if (side.hidden.has(entry.config.id)) {
        appendCommand("hide", side.map, entry.config.id);
      }
    }
  }

  const origin = base ?? window.location.origin + window.location.pathname;
  return `${origin}#${params.toString()}`;
}
