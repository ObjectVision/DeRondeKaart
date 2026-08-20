import { createEffect, createSignal, type Accessor } from "solid-js";

import type { MapAccessor, MapLayerMouseEvent, MapViewHandle } from "@/components/map/map-view-config";
import { getLayerConfigById, loadLayerConfigs, type LayerConfig } from "@/layers";
import { buildNativeLayerDefs, isHighlightLayerId } from "@/layers/mvt-style";
import {
  clearCompareSelections,
  compareSelections,
  isCompareSelectable,
} from "@/layers/compare-slots";
import {
  levelForZoom,
  loadComplementaryConfig,
  type ComplementaryConfig,
} from "@/dashboard/complementary-config";
import { useCompareSelection } from "@/hooks/use-compare-selection";
import type { LayerEntry } from "@/hooks/use-map-layers";

/**
 * Property names carrying a human-readable area name, most specific first.
 * `statnaam` is the CBS export's own spelling; the wijk and buurt files carry
 * no name at all, so those areas fall back to their code.
 */
const NAME_CANDIDATES = ["bu_naam", "wk_naam", "gm_naam", "statnaam", "naam", "name"];

export interface UseComplementaryDashboardResult {
  /** The parsed config; `null` until it has loaded. */
  config: Accessor<ComplementaryConfig | null>;
  /** Code column of the level the current zoom selects at. */
  codeColumn: Accessor<string>;
  /** Handles a map click; false means "not mine, run the normal path". */
  handleClick: (e: MapLayerMouseEvent) => boolean;
  /**
   * Whether a click at this point would select an area — drives the pointer
   * cursor, so it must stay the same test `handleClick` applies.
   */
  isSelectableAt: (point: MapLayerMouseEvent["point"]) => boolean;
  /** True while the comparison panel is open. */
  panelOpen: Accessor<boolean>;
  openPanel: () => void;
  closePanel: () => void;
  removeSlot: (slot: number) => void;
  clearAll: () => void;
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
  addLayer: (config: LayerConfig, map: MapAccessor, options?: { atEnd?: boolean }) => Promise<void>,
  ready: Accessor<boolean>,
): UseComplementaryDashboardResult {
  const [config, setConfig] = createSignal<ComplementaryConfig | null>(null);
  const [panelOpen, setPanelOpen] = createSignal(false);
  const [codeColumn, setCodeColumn] = createSignal("bu_code");

  const getMap: MapAccessor = () => mapLeft()?.map() ?? null;

  /**
   * Put the selection layers on the map ourselves.
   *
   * `layers.json` is a catalogue: a layer reaches the map only through the
   * navigation tree, `pickLayer`, `studyarea` or a share URL. These are none of
   * those — they are invisible, excluded from the legend, and exist purely to
   * be clicked — so the config that names them is what adds them. Same shape as
   * App's `pickLayer` effect, which cannot serve here because it holds a single
   * id and the comparison needs one layer per zoom level.
   *
   * `atEnd` keeps them at the bottom of the draw order, and going through
   * `addLayer` (rather than a study-area-style side channel) is what makes them
   * real layer entries: only those are queried, and `syncImperativeLayers`
   * replays them after a basemap swap.
   */
  let layersAdded = false;
  createEffect(() => {
    if (!ready() || layersAdded) return;
    layersAdded = true;
    void (async () => {
      try {
        const [complementary, configs] = await Promise.all([
          loadComplementaryConfig(),
          loadLayerConfigs(),
        ]);
        setConfig(complementary);

        for (const level of complementary.levels) {
          const layerConfig = getLayerConfigById(configs, level.layer);
          if (!layerConfig) {
            console.warn(
              `dashboard_complementary.json: level layer "${level.layer}" not found in layers.json`,
            );
            continue;
          }
          if (!isCompareSelectable(layerConfig)) {
            console.warn(
              `dashboard_complementary.json: level layer "${level.layer}" is not selectable; ` +
                `it needs both "highlightable" and "compareSelectable" in layers.json`,
            );
            continue;
          }
          await addLayer(layerConfig, getMap, { atEnd: true });
        }
      } catch (err) {
        // Non-fatal: without the layers the map simply has nothing to select,
        // which is how it behaved before the mode existed.
        console.warn("Kon de selectielagen niet toevoegen", err);
      }
    })();
  });

  const configById = (layerId: string): LayerConfig | undefined =>
    entries().find((entry) => entry.config.id === layerId)?.config;

  const selection = useCompareSelection(mapLeft, configById);

  /**
   * The selectable feature at a point, or null when the point misses.
   *
   * Shared by the click handler and the hover cursor so the two can never
   * disagree about what is selectable: the cursor turning into a pointer is a
   * promise that a click there will land, and re-deriving the rule separately
   * would let the zoom level or the outline exclusion drift between them.
   */
  function selectableAt(point: MapLayerMouseEvent["point"]) {
    const current = config();
    const map = mapLeft()?.map();
    if (!current || !map) return null;

    const level = levelForZoom(current, map.getZoom());
    if (!level) return null;

    const layerConfig = configById(level.layer);
    if (!layerConfig) return null;

    // Same id source the pick path uses, so the query matches exactly the
    // layers this config actually put on the map — minus the outlines.
    //
    // The outlines are excluded deliberately: they carry no zoom filter, so a
    // selected gemeente keeps a 3px comparison line at buurt zoom, and clicking
    // that line would toggle the gemeente instead of selecting the buurt under
    // the cursor. Only the data layer answers a click, and its filter is what
    // decides which level a click at this zoom means.
    const layerIds = buildNativeLayerDefs(layerConfig)
      .map((def) => def.id)
      .filter((id) => !isHighlightLayerId(id) && map.getLayer(id));
    if (layerIds.length === 0) return null;

    const [feature] = map.queryRenderedFeatures(point, { layers: layerIds });
    if (!feature || feature.id === undefined) return null;

    // `featureId` is returned separately so the caller keeps the narrowing this
    // guard established — reading it back off `feature` would widen to
    // `undefined` again.
    return { feature, featureId: feature.id, layerConfig, level };
  }

  function isSelectableAt(point: MapLayerMouseEvent["point"]): boolean {
    return selectableAt(point) !== null;
  }

  function handleClick(e: MapLayerMouseEvent): boolean {
    const hit = selectableAt(e.point);
    if (!hit) return false;
    const { feature, featureId, layerConfig, level } = hit;

    const properties = feature.properties ?? {};
    const code = properties[level.code];
    if (typeof code !== "string" || code === "") return false;

    const nameKey = NAME_CANDIDATES.find((key) => typeof properties[key] === "string");
    const label = nameKey ? String(properties[nameKey]) : code;

    setCodeColumn(level.code);
    // A fifth area rolls the oldest out, so this never refuses.
    selection.toggle(layerConfig, featureId, code, label);
    // The click was on a selection area either way — consumed, so no popup.
    return true;
  }

  function clearAll() {
    selection.clear();
    setPanelOpen(false);
  }

  function removeSlot(slot: number) {
    selection.remove(slot);
    if (compareSelections().length === 0) setPanelOpen(false);
  }

  return {
    config,
    codeColumn,
    handleClick,
    isSelectableAt,
    panelOpen,
    openPanel: () => setPanelOpen(true),
    closePanel: () => setPanelOpen(false),
    removeSlot,
    clearAll,
  };
}

/** Drop every selection without a map — for a mode that is being turned off. */
export function resetComplementarySelections(): void {
  clearCompareSelections();
}
