import { createSignal, onMount, type Accessor } from "solid-js";

import type { MapLayerMouseEvent, MapViewHandle } from "@/components/map/map-view-config";
import type { LayerConfig } from "@/layers";
import { buildNativeLayerDefs } from "@/layers/mvt-style";
import { clearCompareSelections, compareSelections } from "@/layers/compare-slots";
import {
  levelForZoom,
  loadComplementaryConfig,
  type ComplementaryConfig,
} from "@/dashboard/complementary-config";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import type { LayerEntry } from "@/hooks/use-map-layers";

/** Property names carrying a human-readable area name, most specific first. */
const NAME_CANDIDATES = ["bu_naam", "wk_naam", "gm_naam", "naam", "name"];

export interface UseComplementaryDashboardResult {
  /** The parsed config; `null` until it has loaded. */
  config: Accessor<ComplementaryConfig | null>;
  /** Code column of the level the current zoom selects at. */
  codeColumn: Accessor<string>;
  /** Handles a map click; false means "not mine, run the normal path". */
  handleClick: (e: MapLayerMouseEvent) => boolean;
  /** True while the comparison panel is open. */
  panelOpen: Accessor<boolean>;
  openPanel: () => void;
  closePanel: () => void;
  removeSlot: (slot: number) => void;
  clearAll: () => void;
  /** Set when a click was refused because all four slots were taken. */
  notice: Accessor<string | null>;
}

/**
 * The in-map half of the dashboard: click areas into comparison slots, then
 * open "meer informatie" over them.
 *
 * The config is fetched once on mount rather than lazily on first click,
 * because the click handler has to know at click time which layer is the
 * selection layer — but it is only mounted when map.json enables the mode, so a
 * project without it fetches nothing.
 */
export function useComplementaryDashboard(
  mapLeft: Accessor<MapViewHandle | null>,
  entries: Accessor<LayerEntry[]>,
): UseComplementaryDashboardResult {
  const [config, setConfig] = createSignal<ComplementaryConfig | null>(null);
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [codeColumn, setCodeColumn] = createSignal("bu_code");

  onMount(() => {
    void loadComplementaryConfig().then(setConfig);
  });

  const configById = (layerId: string): LayerConfig | undefined =>
    entries().find((entry) => entry.config.id === layerId)?.config;

  const selection = useCompareSelection(mapLeft, configById);

  function handleClick(e: MapLayerMouseEvent): boolean {
    const current = config();
    const map = mapLeft()?.map();
    if (!current || !map) return false;

    const level = levelForZoom(current, map.getZoom());
    if (!level) return false;

    const layerConfig = configById(level.layerId);
    if (!layerConfig) return false;

    // Same id source the pick path uses, so the query matches exactly the
    // layers this config actually put on the map.
    const layerIds = buildNativeLayerDefs(layerConfig)
      .map((def) => def.id)
      .filter((id) => map.getLayer(id));
    if (layerIds.length === 0) return false;

    const [feature] = map.queryRenderedFeatures(e.point, { layers: layerIds });
    if (!feature || feature.id === undefined) return false;

    const properties = feature.properties ?? {};
    const code = properties[level.codeColumn];
    if (typeof code !== "string" || code === "") return false;

    const nameKey = NAME_CANDIDATES.find((key) => typeof properties[key] === "string");
    const label = nameKey ? String(properties[nameKey]) : code;

    setCodeColumn(level.codeColumn);
    const added = selection.toggle(layerConfig, feature.id, code, label);
    if (!added && compareSelections().length > 0) {
      setNotice("Er kunnen maximaal vier gebieden vergeleken worden.");
    } else {
      setNotice(null);
    }
    // The click was on a selection area either way — consumed, so no popup.
    return true;
  }

  function clearAll() {
    selection.clear();
    setPanelOpen(false);
    setNotice(null);
  }

  function removeSlot(slot: number) {
    selection.remove(slot);
    setNotice(null);
    if (compareSelections().length === 0) setPanelOpen(false);
  }

  return {
    config,
    codeColumn,
    handleClick,
    panelOpen,
    openPanel: () => setPanelOpen(true),
    closePanel: () => setPanelOpen(false),
    removeSlot,
    clearAll,
    notice,
  };
}

/** Drop every selection without a map — for a mode that is being turned off. */
export function resetComplementarySelections(): void {
  clearCompareSelections();
}
