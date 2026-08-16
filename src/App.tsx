import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapView } from "@/components/map/MapView";
import { useBasemap } from "@/hooks/use-basemap";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useFilterLayers } from "@/hooks/use-filter-layers";
import { useLayerHandlers } from "@/hooks/use-layer-handlers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import {
  useFilteredStudyArea,
  useFilteredStudyAreaLayers,
} from "@/hooks/use-filtered-study-area";
import { useClickMarkerLayers } from "@/hooks/use-click-marker-layer";
import { useMapPointer } from "@/hooks/use-map-pointer";
import { viewForBbox } from "@/lib/fly-to";
import type { BBox } from "@/layers/box-filter";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import {
  DEFAULT_CLICK_MARKER,
  DEFAULT_MAP_CONTROLS,
  chromeIconSize,
  chromeIconColor,
  type ClickMarkerConfig,
  type MapControlsConfig,
} from "@/config/map-config";
import { useFeaturePick } from "@/hooks/use-feature-pick";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import { useClickPopup } from "@/hooks/use-click-popup";
import { useHoverCursor } from "@/hooks/use-hover-cursor";
import { useFeatureHighlight } from "@/hooks/use-feature-highlight";
import { useUrlCommands, type ViewUpdate } from "@/hooks/use-url-commands";
import { useEmbedData, type EmbedConfig } from "@/hooks/use-embed-data";
import { useMapSnapshot } from "@/hooks/use-map-snapshot";
import { useNavigation } from "@/hooks/use-navigation";
import { useAreaFilter } from "@/hooks/use-area-filter";
import { useBoxSelect } from "@/hooks/use-box-select";
import { useSelectionBoxLayers } from "@/hooks/use-selection-box-layer";
import { useAnnotations } from "@/hooks/use-annotations";
import { useCollab } from "@/hooks/use-collab";
import { useAnnotationTool } from "@/hooks/use-annotation-tool";
import { useAnnotationCommands } from "@/hooks/use-annotation-commands";
import { useShareState } from "@/hooks/use-share-state";
import { useHostFilter } from "@/hooks/use-host-filter";
import { useAnnotationSource } from "@/hooks/use-annotation-source";
import { isAnnotationIconified, PIN_SIZE_ACTIVE_PX } from "@/layers/annotation-style";
import { METERS_PER_DEGREE_LAT } from "@/lib/geo";
import { AnnotationEditPopup } from "@/components/annotations/AnnotationEditPopup";
import { AnnotationToolbar } from "@/components/ui/AnnotationToolbar";
import { useChartsPanel } from "@/hooks/use-charts-panel";
import { Legend } from "@/components/ui/legend";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { NavigationPanel } from "@/components/ui/navigation/NavigationPanel";
import { Sidebar } from "@/components/ui/sidebar/Sidebar";
import { SectionToggleBar, type SectionToggle } from "@/components/ui/sidebar/SectionToggleBar";
import { usePanelMinimize } from "@/hooks/use-panel-minimize";
import { MapControls } from "@/components/ui/map-controls";
import { MapAttribution } from "@/components/ui/map-attribution";
import { FeatureInfo } from "@/components/ui/feature-info";
import { StreetView } from "@/components/ui/street-view";
import { InfoPopup } from "@/components/ui/info-popup";
import { BasemapDialog } from "@/components/ui/BasemapDialog";
import { CombineLayersDialog } from "@/components/ui/CombineLayersDialog";
import type { ClassRef } from "@/components/ui/CombineLayersDialog";
import { LayerMetaDialog } from "@/components/ui/LayerMetaDialog";
import { ComparisonSlider } from "@/components/ui/comparison-slider";
import { ChartsPanel } from "@/components/charts/ChartsPanel";
import { ShareDialog } from "@/components/share/ShareDialog";
import { CircularExportView } from "@/components/share/CircularExportView";
import { legendItemsForEntries } from "@/lib/legend-style";
import { resultUsesPblSummary } from "@/lib/pbl-summary";
import { dismissSplash } from "@/lib/splash";

/**
 * Outline the feature a pick result describes, or clear the outline when the
 * result is gone. Lifted out of the component so both maps share one rule.
 *
 * Only the first highlightable feature is marked: the popup shows one layer at
 * a time, and outlining every layer under the pointer would be noise.
 */
function applySelectionHighlight(
  result: FeatureInfoResult | null,
  setSelected: (config: LayerConfig | null, featureId: string | number | null) => void,
): void {
  if (!result) {
    setSelected(null, null);
    return;
  }
  for (const picked of result.featuresByLayer.values()) {
    for (const feature of picked) {
      if (feature.sourceConfig && feature.featureId !== undefined) {
        setSelected(feature.sourceConfig, feature.featureId);
        return;
      }
    }
  }
  setSelected(null, null);
}

function App({
  initialViewState,
  studyAreaId,
  pickLayerId,
  streetviewEnabled = false,
  searchbarEnabled = false,
  navigationEnabled = false,
  navigationMode = "top",
  filterSectionEnabled = true,
  navigationSectionEnabled = true,
  chartsPanelEnabled = true,
  shareEnabled: shareEnabledProp = true,
  filterFlyToEnabled = true,
  combinationsEnabled = false,
  annotationsEnabled: annotationsEnabledProp = false,
  mapControls = DEFAULT_MAP_CONTROLS,
  clickMarker: clickMarkerConfig = DEFAULT_CLICK_MARKER,
  basemapDefault,
  embedCircular = false,
}: {
  initialViewState: ViewState;
  studyAreaId?: string;
  /** Layer added to the left map at startup so clicks have a target; see MapConfig.pickLayer. */
  pickLayerId?: string;
  streetviewEnabled?: boolean;
  searchbarEnabled?: boolean;
  navigationEnabled?: boolean;
  navigationMode?: "top" | "sidebar";
  filterSectionEnabled?: boolean;
  navigationSectionEnabled?: boolean;
  chartsPanelEnabled?: boolean;
  shareEnabled?: boolean;
  filterFlyToEnabled?: boolean;
  /** map.json `combinations` — the "Lagen combineren" toolbutton + Combinaties thema. */
  combinationsEnabled?: boolean;
  annotationsEnabled?: boolean;
  mapControls?: MapControlsConfig;
  clickMarker?: ClickMarkerConfig;
  /** map.json `basemap` — the basemap a fresh session starts on. */
  basemapDefault?: string;
  /**
   * Boot straight into the standalone circular-export view (only the circular
   * map + legend + title, no chrome/dialog) — set from the `?embed=circular`
   * URL param for embedding on a webpage. Layers/view/title are then driven by
   * the existing `cmd`/`layer` URL params and `open-circular` messages.
   */
  embedCircular?: boolean;
}) {
  // UI-surface flags are seeded from map.json (props) but can be overridden at
  // runtime by an embedding host (Power BI visual) via the `map-config` message.
  const [streetview, setStreetviewEnabled] = useState(streetviewEnabled);
  const [searchbar, setSearchbarEnabled] = useState(searchbarEnabled);
  const [navigation, setNavigationEnabled] = useState(navigationEnabled);
  const [shareEnabled, setShareEnabled] = useState(shareEnabledProp);
  const [annotationsEnabled, setAnnotationsEnabled] = useState(annotationsEnabledProp);
  const [combineOpen, setCombineOpen] = useState(false);
  // Bumped on each opening to remount CombineLayersDialog, so it starts from a
  // clean selection instead of resetting itself in an effect.
  const [combineSession, setCombineSession] = useState(0);
  const sidebarMode = navigationMode === "sidebar";

  const mapLeftLayers = useMapLayers();
  const mapRightLayers = useMapLayers();

  // Session-scoped combination layers ("Lagen combineren"). Bound to the LEFT
  // stack: a combination is one new layer, so it belongs to one map.
  const filterLayers = useFilterLayers(
    mapLeftLayers.addLayer,
    mapLeftLayers.removeLayer,
  );

  // Per-layer z-ordering is handled entirely in the layer factory via the
  // `beforeid` anchor from each config (see anchorForConfig) — no App-level wiring.

  // Mount the right map only when it has a comparable (non-flagged) layer — a
  // flagged-only right map has nothing meaningful to compare and is hidden with
  // the slider. Computed up here because the B-side topLayer hooks below are
  // gated on it: a deck Layer instance whose GL resources were created by the
  // right map's deck must not survive that map's unmount — handing it to the
  // remounted map's fresh deck draws against dead GL programs
  // ("getUniformBlockIndex ... not of type 'WebGLProgram'" floods). Gating the
  // hooks drops the instances at unmount and rebuilds them on remount.
  const showMapRight = mapRightLayers.layerEntries.some(
    (e) => !e.config.excludeFromComparison,
  );

  // Gemeente/Wijk/Buurt area filter (sidebar). Selections live in a module
  // store read by the layer accessors; on change, re-clone both maps' deck
  // layers so the accessors re-evaluate. Declared up here because the study
  // area below swaps to the selected gebied's geometry.
  //
  // The filter's fly-to normally reaches the maps through the shared `map:flyto`
  // event, which only MOUNTED MapViews listen to. The circular-only view renders
  // without any (see showCircularOnly's early return), so there the event has no
  // listener and the camera would never follow the filter. onFlyToBbox lets us
  // drive viewState directly in that case; the ref is filled in below, once
  // applyView and the circular flag exist.
  const filterFlyToBboxRef = useRef<((bbox: BBox) => void) | null>(null);
  const areaFilter = useAreaFilter({
    flyTo: filterFlyToEnabled,
    onFlyToBbox: (bbox) => filterFlyToBboxRef.current?.(bbox),
  });

  const mapLeftRef = useRef<MapViewHandle>(null);
  const mapRightRef = useRef<MapViewHandle>(null);

  // Always-on study area, pinned to the `studyarea-layers` anchor band on both
  // maps. While a gebiedsfilter selection is active the configured studyarea is
  // replaced by the selected gebied (finest level): a 200 km mask disc around
  // it plus the gebied outline — so the configured one is removed by passing
  // `undefined`, which native layers (unlike deck's arrays) require.
  const filteredStudy = useFilteredStudyArea(areaFilter);
  const studyAreaA = useStudyAreaLayer(
    filteredStudy ? undefined : studyAreaId,
    mapLeftRef,
  );
  const studyAreaB = useStudyAreaLayer(
    showMapRight && !filteredStudy ? studyAreaId : undefined,
    mapRightRef,
  );
  const filteredStudyA = useFilteredStudyAreaLayers(filteredStudy, mapLeftRef);
  const filteredStudyB = useFilteredStudyAreaLayers(
    showMapRight ? filteredStudy : null,
    mapRightRef,
  );
  const [mapLeftReady, setMapLeftReady] = useState(false);

  const [viewState, setViewState] = useState(initialViewState);
  const [sliderPosition, setSliderPosition] = useState(50);

  // Selected background basemap (shared by both maps). The legend's map button
  // opens the picker; only the base style swaps — user layers stay, re-added
  // by each map's onLabelsReady below.
  const { basemapId, setBasemap } = useBasemap({ configDefault: basemapDefault });
  const [basemapDialogOpen, setBasemapDialogOpen] = useState(false);
  const openBasemapDialog = useCallback(() => setBasemapDialogOpen(true), []);

  // A layer's metainfo window, opened from the legend's info button or from
  // under a navigation description. Holds the layer rather than a bare id so
  // the dialog can title itself without re-resolving layers.json.
  const [metaLayer, setMetaLayer] = useState<{ id: string; name: string } | null>(null);
  const openLayerMeta = useCallback(
    (id: string, name: string) => setMetaLayer({ id, name }),
    [],
  );
  const closeLayerMeta = useCallback((open: boolean) => {
    if (!open) setMetaLayer(null);
  }, []);

  // Feature picking for each map
  const pickA = useFeaturePick(mapLeftLayers.layerEntries, mapLeftRef);
  const pickB = useFeaturePick(mapRightLayers.layerEntries, mapRightRef);

  // Feature highlighting (hover outline + the clicked feature) per map. Kept
  // per map because feature state lives on that map's own style instance.
  const highlightA = useFeatureHighlight(mapLeftRef);
  const highlightB = useFeatureHighlight(mapRightRef);

  // Hover cursor (pointer over clickable features, grab otherwise) for each map
  const hoverA = useHoverCursor(mapLeftLayers.layerEntries, mapLeftRef, highlightA.setHovered);
  const hoverB = useHoverCursor(mapRightLayers.layerEntries, mapRightRef, highlightB.setHovered);

  // The shared click popup: marker point, Street View target, popup anchor, and
  // which map's pick is on show. Shared across both maps — a click on either one
  // replaces the popup, and closing it clears both picks.
  const {
    popupPoint,
    setPopupPoint,
    clickMarker,
    streetView,
    handleMapClick,
    pickResult,
    pickEntries,
    closePopup,
  } = useClickPopup({
    streetviewEnabled: streetview,
    pickA,
    pickB,
    leftEntries: mapLeftLayers.layerEntries,
    rightEntries: mapRightLayers.layerEntries,
  });

  // Pin the highlight to whichever feature the open popup is describing, and
  // drop it when the popup closes — that is what makes the outline read as
  // "this is the one you clicked" rather than a second hover.
  //
  // Driven off the pick results rather than the click handler so it follows the
  // popup's real lifecycle, including closing via the × or a click on water.
  useEffect(() => {
    applySelectionHighlight(pickA.result, highlightA.setSelected);
  }, [pickA.result, highlightA.setSelected]);

  useEffect(() => {
    applySelectionHighlight(pickB.result, highlightB.setSelected);
  }, [pickB.result, highlightB.setSelected]);

  // Per-map marker overlays, drawn as MapLibre symbol layers on each map's own
  // style. map.json `clickMarker.enabled: false` (or `clickMarker: false`)
  // suppresses the marker; clicks still open popups/Street View.
  const markerPoint = clickMarkerConfig.enabled ? clickMarker : null;
  const markerA = useClickMarkerLayers(markerPoint, mapLeftRef, clickMarkerConfig);
  const markerB = useClickMarkerLayers(
    showMapRight ? markerPoint : null,
    mapRightRef,
    clickMarkerConfig,
  );

  // Area-select tool: a drawn rectangle restricting the charts/statistics to
  // rows inside it (ANDed with the area filter). One shared instance — the box
  // is a single filter shown on both maps; map rendering is unaffected.
  const boxSelect = useBoxSelect();
  const { active: boxSelectActive, toggle: boxSelectToggle } = boxSelect;
  const selectionBox = boxSelect.draft ?? boxSelect.box;
  const boxA = useSelectionBoxLayers(selectionBox, mapLeftRef);
  const boxB = useSelectionBoxLayers(showMapRight ? selectionBox : null, mapRightRef);

  // Annotation tool: circles around areas of interest, each carrying a
  // title/description and a snapshot of the session (gebiedsfilters, both
  // maps' layers, camera). Annotations live in a Y.Doc from the start, so
  // sharing later just attaches a collab provider (live cursors, shared
  // edits) to the same doc — Yjs merges the local annotations into the room.
  const annotations = useAnnotations();
  const collab = useCollab(annotations.doc);
  const { startSession, setCursor, setActiveAnnotation } = collab;

  // Live refs for the async snapshot restore: layer adds await full data
  // loads, so state objects captured at click time go stale mid-run.
  /* eslint-disable react-hooks/refs -- deliberate latest-value mirrors */
  const areaFilterRef = useRef(areaFilter);
  areaFilterRef.current = areaFilter;
  /* eslint-enable react-hooks/refs */

  // Annotation writes + map picking. Owns its own live-value refs for the
  // async snapshot restore; `areaFilterRef` is shared with the host bridge.
  const annotationCommands = useAnnotationCommands({
    annotations,
    identity: collab.identity,
    areaFilter,
    mapLeftLayers,
    mapRightLayers,
    viewState,
    mapLeftRef,
    mapRightRef,
    areaFilterRef,
  });

  const annotationTool = useAnnotationTool({
    onCreate: annotationCommands.createCircle,
    onCreatePolygon: annotationCommands.createPolygon,
    onCreatePin: annotationCommands.createPin,
    onMove: annotationCommands.move,
    onResize: annotationCommands.resize,
    onEditPoints: annotationCommands.editPoints,
    onRestore: annotationCommands.restore,
    onDelete: (id) => annotations.remove(id),
    pickAnnotationAt: annotationCommands.pickAt,
  });
  const {
    active: annotationActive,
    toggle: annotationToggle,
    activate: annotationActivate,
    select: annotationSelect,
    selectedId: annotationSelectedId,
    tool: annotationDrawTool,
    setTool: annotationSetTool,
  } = annotationTool;

  // Broadcast the local selection so peers see which circle is being viewed.
  useEffect(() => {
    setActiveAnnotation(annotationSelectedId);
  }, [annotationSelectedId, setActiveAnnotation]);

  const selectedAnnotation =
    annotations.annotations.find((a) => a.id === annotationSelectedId) ?? null;
  // The selected annotation was deleted (possibly by a peer) — close the popup.
  useEffect(() => {
    if (annotationSelectedId && !selectedAnnotation) annotationSelect(null);
  }, [annotationSelectedId, selectedAnnotation, annotationSelect]);

  // Screen anchor for the edit popup: the top of the selected shape (topmost
  // vertex for polygons, top of the rim for circles), projected through the
  // left map (both maps share the viewState, so the projection is identical).
  // viewState is a dependency so the popup tracks the shape while the map
  // pans or a snapshot restore flies.
  const annotationPopupPos = useMemo(() => {
    if (!selectedAnnotation) return null;
    // eslint-disable-next-line react-hooks/refs
    const map = mapLeftRef.current?.mapRef.current?.getMap();
    if (!map) return null;
    const c = map.project([selectedAnnotation.center.lng, selectedAnnotation.center.lat]);
    if (selectedAnnotation.pin) {
      // The pin icon extends upward from its anchored tip.
      return { x: c.x, y: c.y - PIN_SIZE_ACTIVE_PX };
    }
    if (isAnnotationIconified(selectedAnnotation, viewState.zoom)) {
      // Far-zoom icon form: center-anchored, half the icon extends upward.
      return { x: c.x, y: c.y - PIN_SIZE_ACTIVE_PX / 2 };
    }
    if (selectedAnnotation.points) {
      let minY = Infinity;
      for (const p of selectedAnnotation.points) {
        const q = map.project([p.lng, p.lat]);
        if (q.y < minY) minY = q.y;
      }
      return { x: c.x, y: minY };
    }
    // Circle rim top: the radius northward from the center.
    const top = map.project([
      selectedAnnotation.center.lng,
      selectedAnnotation.center.lat + selectedAnnotation.radiusM / METERS_PER_DEGREE_LAT,
    ]);
    return { x: c.x, y: top.y };
  }, [selectedAnnotation, viewState]);

  const annotationsVisible = annotationsEnabled && annotationActive;
  // Annotation bodies (shapes, icons, labels, peer cursors) render as native
  // MapLibre sources on each map's own style. iconScale 4 supersamples the
  // sprite images, declared back as `pixelRatio` — ≥ the 32-38px draw size on
  // hi-DPI screens, so pins stay crisp without a jagged downscale.
  const annotSourceA = useAnnotationSource(mapLeftRef, {
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: collab.identity.color,
    visible: annotationsVisible,
    zoom: viewState.zoom,
    iconScale: 4,
  });
  const annotSourceB = useAnnotationSource(mapRightRef, {
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: collab.identity.color,
    visible: annotationsVisible && showMapRight,
    zoom: viewState.zoom,
    iconScale: 4,
  });
  // Mirror the tool state into both maps' cursor flags (crosshair while armed).
  // Annotation mode alone doesn't claim the crosshair — only an armed drawing
  // tool does; without one the map navigates (and shows cursors) as usual.
  const drawToolArmed = boxSelect.active || annotationDrawTool !== null;
  useEffect(() => {
    for (const handle of [mapLeftRef.current, mapRightRef.current]) {
      if (!handle) continue;
      handle.drawModeRef.current = drawToolArmed;
      const canvas = handle.mapRef.current?.getMap()?.getCanvas();
      if (canvas) canvas.style.cursor = drawToolArmed ? "crosshair" : "";
    }
  }, [drawToolArmed]);

  // One click, move or drag fanned out across picking, hover, area-select,
  // annotation drawing, the click marker and collab presence — plus the mutual
  // exclusion between the two draw tools.
  const pointer = useMapPointer({
    mapLeftRef,
    mapRightRef,
    leftEntries: mapLeftLayers.layerEntries,
    rightEntries: mapRightLayers.layerEntries,
    pickA,
    pickB,
    hoverA,
    hoverB,
    boxSelect,
    annotationTool,
    annotationActive,
    annotationToggle,
    setCursor,
    setPopupPoint,
    handleMapClick,
  });
  const handleAnnotationToolToggle = pointer.toggleAnnotationTool;
  const handleAreaSelectToggle = pointer.toggleAreaSelect;

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({ mapLeftLayers, mapRightLayers, mapLeftRef, mapRightRef });

  // The always-on pick layer (map.json `pickLayer`): an invisible layer added to
  // the left map at startup so a click anywhere has a feature to hit, without the
  // user having added anything. It goes through addLayer — rather than a
  // study-area-style side channel — for two reasons: only a real layer entry is
  // ever queried for feature picking, and syncImperativeLayers then replays it
  // after a basemap swap for free.
  //
  // `atEnd` keeps it at the bottom of the draw order, so a layer the user adds
  // later paints above it. addLayer is a no-op for an id already present, which
  // is what makes re-running this safe.
  const pickLayerAddedRef = useRef(false);
  useEffect(() => {
    if (!pickLayerId || !mapLeftReady || pickLayerAddedRef.current) return;
    pickLayerAddedRef.current = true;
    let alive = true;
    loadLayerConfigs()
      .then((configs) => {
        const config = getLayerConfigById(configs, pickLayerId);
        if (!config) {
          console.warn(`map.json: pickLayer "${pickLayerId}" not found in layers.json`);
          return;
        }
        // MapViewHandle wraps the react-map-gl ref; addLayer wants the inner one.
        const inner = mapLeftRef.current?.mapRef;
        if (alive && inner) void mapLeftLayers.addLayer(config, inner, { atEnd: true });
      })
      .catch((err) => {
        // Non-fatal: without it the map simply has nothing to click, which is
        // how every other config behaves.
        console.warn(`Failed to add pickLayer "${pickLayerId}":`, err);
      });
    return () => {
      alive = false;
    };
  }, [pickLayerId, mapLeftReady, mapLeftLayers, mapLeftRef]);

  // The layer cross-references inside a layer's metainfo, which the publisher
  // still points at the retired 2025 mapviewer. Handed to LayerMetaDialog so
  // those links act on this viewer instead.
  const addMetaLayerToLeftMap = useCallback(
    (id: string) => {
      // The link reads "add", never "remove": toggleOnMap would take an
      // already-visible layer back off the map, which is not what it promises.
      if (nav.isOnMap(id, "a")) return;
      void nav.toggleOnMap(id, "a");
    },
    [nav],
  );
  const isMetaLayerOnLeftMap = useCallback((id: string) => nav.isOnMap(id, "a"), [nav]);

  // Minimize state for the navigation, statistics and legend windows (persisted
  // for the session) plus the small-screen auto-collapse that drives all three.
  const {
    navMinimized,
    toggleNavMinimized,
    chartsMinimized,
    setChartsMinimized,
    toggleChartsMinimized,
    legendMinimized,
    toggleLegendMinimized,
  } = usePanelMinimize();

  // Analytics ("Analyse & statistieken") panel: selected via a layer-name
  // click in the legend; fed by the layer's attribute table restricted to the
  // current area filter.
  const { chartLayerConfig, handleChartsClose } = useChartsPanel({
    mapLeftLayers,
    mapRightLayers,
    chartsPanelEnabled,
    setChartsMinimized,
    boxSelectActive,
    boxSelectToggle,
  });

  // "Delen" (share/export) dialog. The circular preview mirrors the on-screen
  // map side: B when the right map renders full-width on top (same rule as the
  // legend's mapBOnTop); comparison mode previews map A — a circular still
  // can't represent a slider comparison.
  const {
    shareOpen,
    setShareOpen,
    circularOpen,
    setCircularOpen,
    shareTitle,
    setShareTitle,
    shareSubtitle,
    setShareSubtitle,
    openCircular,
  } = useShareState({
    shareEnabled,
    annotationsEnabled,
    annotationActive,
    collabRoomId: collab.roomId,
    startSession,
  });

  const sidebarActive = sidebarMode && navigation;
  const filterAvailable = sidebarActive && filterSectionEnabled && areaFilter.entries.length > 0;
  const navAvailable = sidebarActive && navigationSectionEnabled;

  // The navigation UI embeds the MapControls card (search + zoom) whenever it is
  // shown: the top-center panel (top mode) or the sidebar toolbar (sidebar mode).
  // When it isn't, we render a standalone card so the controls stay independent
  // of the navigation flag (map.json `mapControls`).
  const navShowsControls = sidebarActive || (navigation && !sidebarMode);

  // Single combined toggle for the whole navigation (Filter + Navigatie). It
  // only appears while minimized — restoring the window. Closing happens via
  // the close button inside the navigation window itself. Memoized (with the
  // toolbar below) so the memoized Sidebar doesn't re-render per map frame.
  const sectionToggles = useMemo<SectionToggle[]>(
    () =>
      (filterAvailable || navAvailable) && navMinimized
        ? [
            {
              key: "navigation",
              icon: "layers",
              title: "Navigatie tonen",
              active: false,
              onToggle: toggleNavMinimized,
            },
          ]
        : [],
    [filterAvailable, navAvailable, navMinimized, toggleNavMinimized],
  );
  // The statistics-panel restore button lives top-right (next to where the
  // panel itself docks), not in this top-left toolbar — see the render below.

  const refreshLeft = mapLeftLayers.refreshAreaFilter;
  const refreshRight = mapRightLayers.refreshAreaFilter;
  useEffect(() => {
    if (areaFilter.version === 0) return; // initial no-filter render
    // Native layers live on a specific map, so each side's refresh gets its own
    // map ref (deck.gl layers are re-cloned regardless).
    refreshLeft(areaFilter.version, [mapLeftRef.current?.mapRef ?? { current: null }]);
    refreshRight(areaFilter.version, [mapRightRef.current?.mapRef ?? { current: null }]);
  }, [areaFilter.version, refreshLeft, refreshRight]);

  const applyView = useCallback((view: ViewUpdate) => {
    // A bbox resolves to center/zoom through the shared fly-to heuristic
    // (same formula the filter fly-to uses); explicit center/zoom still win.
    const framed = view.bbox ? viewForBbox(view.bbox) : null;
    setViewState((s) => ({
      ...s,
      ...(framed
        ? { longitude: framed.center[0], latitude: framed.center[1], zoom: framed.zoom }
        : {}),
      ...(view.zoom !== undefined ? { zoom: view.zoom } : {}),
      ...(view.center ? { longitude: view.center[0], latitude: view.center[1] } : {}),
    }));
  }, []);

  // Fill in the filter fly-to fallback declared above. Only active while the
  // circular-only view is showing: with no MapView mounted, nothing listens to
  // the `map:flyto` event and nothing feeds a camera back into viewState (that's
  // handleMove, a prop of those unmounted maps). Routing the bbox through
  // applyView moves the circle instead. In the normal app this stays null so the
  // animated MapLibre flyTo remains authoritative — a hard setViewState there
  // would replace the animation with a jump.
  const circularOnlyActive = embedCircular || (shareEnabled && circularOpen);
  useEffect(() => {
    filterFlyToBboxRef.current = circularOnlyActive
      ? (bbox: BBox) => applyView({ bbox })
      : null;
  }, [circularOnlyActive, applyView]);

  // A share link with an `annot` room: enter annotation mode and join the
  // collab session directly (ignored when the feature is disabled here).
  const handleAnnotationRoom = useCallback(
    (roomId: string) => {
      if (!annotationsEnabled) return;
      annotationActivate();
      startSession(roomId);
    },
    [annotationsEnabled, annotationActivate, startSession],
  );

  // Host `filter` messages -> one committed gebiedsfilter selection.
  const setFilterFromHost = useHostFilter({
    areaFilterRef,
    areaFilter,
    applyView,
    initialViewState,
  });

  // Process URL commands for layer management (only after the left map is
  // ready). In the standalone circular embed the main left map is never
  // mounted, so gate on embedCircular too — layer entries populate without a
  // live map (ExportPreviewMap re-syncs any native MVT/COG layers itself).
  useUrlCommands({
    mapLeft: { layers: mapLeftLayers, mapRef: mapLeftRef }, // "linker kaart"
    mapRight: { layers: mapRightLayers, mapRef: mapRightRef }, // "rechter kaart"
    ready: mapLeftReady || embedCircular,
    applyView,
    onAnnotationRoom: handleAnnotationRoom,
    onBasemap: setBasemap,
    onOpenCircular: openCircular,
    onSetFilter: setFilterFromHost,
  });

  // Apply runtime UI-config overrides from an embedding host (Power BI visual).
  const applyConfig = useCallback((cfg: EmbedConfig) => {
    if (typeof cfg.searchbar === "boolean") setSearchbarEnabled(cfg.searchbar);
    if (typeof cfg.navigation === "boolean") setNavigationEnabled(cfg.navigation);
    if (typeof cfg.streetview === "boolean") setStreetviewEnabled(cfg.streetview);
    if (typeof cfg.share === "boolean") setShareEnabled(cfg.share);
    if (typeof cfg.annotations === "boolean") setAnnotationsEnabled(cfg.annotations);
  }, []);

  // In-memory data pushed by an embedding host (Power BI visual): renders on
  // the left map and posts the map-ready handshake to the parent window. In the
  // standalone circular embed the main left map is never mounted, so treat the
  // app as ready once mounted — the postMessage handlers don't need a live map.
  useEmbedData({
    mapLeftLayers,
    mapLeftRef,
    ready: mapLeftReady || embedCircular,
    onConfig: applyConfig,
  });

  const hasMapLeftLayers = mapLeftLayers.layerEntries.length > 0;

  // Comparison requires layers on the left and a comparable layer on the right
  // (showMapRight, computed near the top with the B-side topLayer hooks).
  const comparisonMode = hasMapLeftLayers && showMapRight;

  // Legend placement. The bottom-left legend belongs to the map shown on that
  // side: map A normally, but map B when it renders full-width on top with no
  // left-map layers (mapBOnTop, outside comparison mode). The bottom-right
  // legend (map B) only appears in comparison mode, when both maps are visible.
  const leftLegendUsesMapB = !comparisonMode && showMapRight;

  // While embedded (Power BI visual), keep pushing map snapshots to the parent
  // so dashboard PDF export shows the map (the iframe itself exports blank).
  useMapSnapshot({
    mapLeftRef,
    mapRightRef,
    comparisonMode,
    sliderPosition,
    ready: mapLeftReady,
  });

  // The left map is the primary one, so its first load is the moment the app
  // has something real to show — that is when the boot splash comes down.
  const handleMapLeftLoad = useCallback(() => {
    setMapLeftReady(true);
    dismissSplash();
  }, []);

  // Once the right map's MapLibre style is loaded, replay any imperative MVT/COG
  // entries that addLayer attempted before the map existed. Idempotent.
  const handleMapRightLoad = useCallback(() => {
    const ref = mapRightRef.current?.mapRef;
    if (ref) mapRightLayers.syncImperativeLayers(ref);
  }, [mapRightLayers]);

  const handleMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState((prev) => ({
      ...prev,
      ...evt.viewState,
      pitch: 0,
      bearing: 0,
    }));
  }, []);

  // One set of legend/UI callbacks per map, bound to that map's layer stack and
  // ref. Also owns each map's timeseries playback timers.
  const handlersA = useLayerHandlers(mapLeftLayers, mapLeftRef);
  const handlersB = useLayerHandlers(mapRightLayers, mapRightRef);

  // Whichever map the bottom-left legend is driving — resolved once so that
  // Legend reads one pair of values instead of repeating the same test per prop.
  const leftLegendLayers = leftLegendUsesMapB ? mapRightLayers : mapLeftLayers;
  const leftLegendHandlers = leftLegendUsesMapB ? handlersB : handlersA;

  // Move a layer between maps: re-add its config to the destination map, then
  // remove it from the source. The layer's config is the source of truth for
  // which map it lives on, so the legend button icon follows automatically.
  const handleMoveToRight = useCallback(
    (layerId: string) => {
      const entry = mapLeftLayers.layerEntries.find((e) => e.config.id === layerId);
      if (!entry) return;
      mapRightLayers.addLayer(entry.config, mapRightRef.current?.mapRef ?? { current: null });
      mapLeftLayers.removeLayer(layerId, mapLeftRef.current?.mapRef ?? { current: null });
    },
    [mapLeftLayers, mapRightLayers],
  );

  const handleMoveToLeft = useCallback(
    (layerId: string) => {
      const entry = mapRightLayers.layerEntries.find((e) => e.config.id === layerId);
      if (!entry) return;
      mapLeftLayers.addLayer(entry.config, mapLeftRef.current?.mapRef ?? { current: null });
      mapRightLayers.removeLayer(layerId, mapRightRef.current?.mapRef ?? { current: null });
    },
    [mapLeftLayers, mapRightLayers],
  );

  // Fired once anchors + overlay are (re)loaded — on initial load and after a
  // basemap swap. setStyle wipes native MVT/COG layers, so re-add them; the
  // helpers are idempotent and skip layers/sources that already exist.
  // Each imperative overlay owns its own re-add: they live outside
  // useMapLayers (and outside deck, which used to re-resolve its layers for
  // free), so a basemap swap would otherwise drop them silently.
  const handleMapLeftLabelsReady = useCallback(() => {
    const ref = mapLeftRef.current?.mapRef;
    if (ref) mapLeftLayers.syncImperativeLayers(ref);
    // setStyle drops every source along with its feature state, so the ids the
    // highlight hook is holding now address nothing. Forget them, or the next
    // hover would try to clear a feature that no longer exists and leave the
    // new one unhighlighted.
    highlightA.clearAll();
    studyAreaA.resync();
    filteredStudyA.resync();
    markerA.resync();
    boxA.resync();
    annotSourceA.resync();
  }, [mapLeftLayers, highlightA, studyAreaA, filteredStudyA, markerA, boxA, annotSourceA]);

  const handleMapRightLabelsReady = useCallback(() => {
    const ref = mapRightRef.current?.mapRef;
    if (ref) mapRightLayers.syncImperativeLayers(ref);
    // See handleMapLeftLabelsReady: the style swap took the feature state with it.
    highlightB.clearAll();
    studyAreaB.resync();
    filteredStudyB.resync();
    markerB.resync();
    boxB.resync();
    annotSourceB.resync();
  }, [mapRightLayers, highlightB, studyAreaB, filteredStudyB, markerB, boxB, annotSourceB]);

  // The share toolbutton, rendered as its own card so it matches the sibling
  // toolbar cards. In sidebar mode it slots into the toolbar row (after the
  // nav-restore toggle, before the map controls); otherwise it stands alone
  // top-left.
  const handleZoomIn = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: prev.zoom + 1 }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: Math.max(0, prev.zoom - 1) }));
  }, []);

  const shareButton = useMemo(
    () =>
      shareEnabled ? (
        <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShareOpen(true)}
            title="Delen"
            aria-label="Delen"
          >
            <Icon name="share" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>
      ) : null,
    [shareEnabled, setShareOpen],
  );

  // "Lagen combineren" — sits between Delen and the map controls (search).
  const combineButton = useMemo(
    () =>
      combinationsEnabled ? (
        <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setCombineSession((n) => n + 1);
              setCombineOpen(true);
            }}
            title="Lagen combineren"
            aria-label="Lagen combineren"
          >
            <Icon name="masked_transitions_add" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        </div>
      ) : null,
    [combinationsEnabled],
  );

  const handleCreateCombination = useCallback(
    (name: string, refs: ClassRef[]) => {
      const configs = mapLeftLayers.layerEntries.map((entry) => entry.config);
      const mapRef = mapLeftRef.current?.mapRef ?? { current: null };
      // Fire-and-forget: reading and scoring the rasters takes a moment, and the
      // hook surfaces both progress and failure through its own state.
      void filterLayers.create(name, refs, configs, [mapRef]);
    },
    [mapLeftLayers.layerEntries, filterLayers],
  );

  // Layers offered for combining: those on the LEFT map that define classes AND
  // have a companion class raster. Left-only because a combination produces one
  // new layer, and sourcing its inputs from two independent stacks would make
  // which map it belongs to ambiguous. `filterRaster` is required because the
  // score is computed cell-by-cell off that shared grid — a layer without one
  // has nothing to combine.
  const combinableLayers = useMemo(
    () =>
      mapLeftLayers.layerEntries
        .map((entry) => entry.config)
        .filter(
          (config) =>
            (config.geostyler?.rules?.length ?? 0) > 0 && config.filterRaster,
        ),
    [mapLeftLayers.layerEntries],
  );

  // Stable toolbar element for the memoized Sidebar (an inline fragment would
  // be a new element every render, defeating its memo).
  const sidebarToolbar = useMemo(
    () => (
      <>
        {/* Navigation-restore toggle sits left of the map controls, so
            reopening the navigation happens at the far-left of the row.
            The share card follows it; map controls (search rightmost)
            close the row. */}
        <SectionToggleBar orientation="horizontal" toggles={sectionToggles} />
        {shareButton}
        {combineButton}
        <MapControls
          orientation="horizontal"
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          showSearch={mapControls.search}
          showZoom={mapControls.zoom}
        />
      </>
    ),
    [
      sectionToggles,
      shareButton,
      combineButton,
      handleZoomIn,
      handleZoomOut,
      mapControls.search,
      mapControls.zoom,
    ],
  );

  // On-screen side shown in the share preview/PNG (see shareOpen comment).
  const shareSide = !comparisonMode && showMapRight ? mapRightLayers : mapLeftLayers;

  // Legend rows for the circular export view (same flattening the dialog +
  // PNG use). Cheap; recomputed when the shown side's layers/visibility change.
  const circularLegendItems = legendItemsForEntries(
    shareSide.layerEntries,
    shareSide.hiddenIds,
    shareSide.hiddenRules,
  );

  // The reusable circular map + legend + title, in fixed-text display mode.
  // Shared by the standalone `?embed=circular` page and the `open-circular`
  // message.
  //
  // Deliberately NOT keyed on the layer set: a key change remounts the whole
  // subtree, which tears down the MapLibre instance and refetches the basemap,
  // sprites and tiles on every layer switch. The point of the postMessage API is
  // that swapping layers adds/removes just those layers, so ExportPreviewMap
  // reconciles its own layer set from `entries` instead (and adopts camera
  // changes through initialViewState). The map instance is long-lived.
  const circularView = (
    <CircularExportView
      entries={shareSide.layerEntries}
      hiddenIds={shareSide.hiddenIds}
      hiddenRules={shareSide.hiddenRules}
      basemapId={basemapId}
      studyAreaId={studyAreaId}
      filteredStudy={filteredStudy}
      annotations={annotationsVisible ? annotations.annotations : undefined}
      initialViewState={viewState}
      legendItems={circularLegendItems}
      title={shareTitle}
      subtitle={shareSubtitle}
      mode="display"
      size="fill"
    />
  );

  // Circular-only view: NOTHING but the circle + legend + title, centered on a
  // white page — no map chrome, toolbar, sidebar or backdrop. Rendered both for
  // the standalone `?embed=circular` page and when a host `open-circular`
  // message requests it (the message-driven case gets a close button to return
  // to the full app). This replaces the whole app rather than overlaying it.
  const showCircularOnly = circularOnlyActive;
  if (showCircularOnly) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-white">
        {/* No close button in standalone embed mode — it's the whole page. */}
        {!embedCircular && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-3 top-3 z-10"
            onClick={() => setCircularOpen(false)}
            title="Sluiten"
            aria-label="Sluiten"
          >
            <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
          </Button>
        )}
        {/* size="fill" sizes the circle to the viewport itself — no width cap here. */}
        {circularView}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {/* Left map — full width in single mode, clipped left in comparison */}
      <div
        className="absolute inset-0 touch-none"
        style={
          comparisonMode
            ? { clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }
            : undefined
        }
      >
        <MapView
          ref={mapLeftRef}
          basemapId={basemapId}
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onClick={pointer.a.onClick}
          onMouseMove={pointer.a.onMouseMove}
          onMouseDown={pointer.a.onMouseDown}
          onMouseUp={pointer.onMouseUp}
          onLoad={handleMapLeftLoad}
          onLabelsReady={handleMapLeftLabelsReady}
        />
      </div>

      {/* Right map — mounted whenever it has its own layers. Only clipped in
          comparison mode; otherwise renders full-width on top of the left map. */}
      {showMapRight && (
        <div
          className="absolute inset-0 touch-none"
          style={
            comparisonMode
              ? { clipPath: `inset(0 0 0 ${sliderPosition}%)` }
              : undefined
          }
        >
          <MapView
            ref={mapRightRef}
            basemapId={basemapId}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
            onClick={pointer.b.onClick}
            onMouseMove={pointer.b.onMouseMove}
            onMouseDown={pointer.b.onMouseDown}
            onMouseUp={pointer.onMouseUp}
            onLoad={handleMapRightLoad}
            onLabelsReady={handleMapRightLabelsReady}
          />
        </div>
      )}

      {/* Comparison slider */}
      {comparisonMode && (
        <ComparisonSlider
          position={sliderPosition}
          onPositionChange={setSliderPosition}
        />
      )}

      {/* Navigation menu — top center (includes map controls: search, +, -).
          In sidebar mode only the search bar remains here. */}
      <NavigationPanel
        nav={nav}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        showSearch={searchbar}
        showNavigation={navigation && !sidebarMode}
        showControlsSearch={mapControls.search}
        showControlsZoom={mapControls.zoom}
        showCombinations={combinationsEnabled}
        combinationLeaves={filterLayers.leaves}
        onOpenMeta={openLayerMeta}
      />

      {/* Bottom-right stack: standalone map controls (search + zoom, only
          when the navigation UI isn't already showing the MapControls card)
          above the map-attribution info button, which replaces MapLibre's
          default attribution control. */}
      <div className="absolute bottom-2 right-2 z-30 flex flex-col items-end gap-2 sm:bottom-4 sm:right-4">
        {!navShowsControls && (mapControls.search || mapControls.zoom) && (
          <MapControls
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            showSearch={mapControls.search}
            showZoom={mapControls.zoom}
          />
        )}
        {/* Right-map legend sits to the left of the attribution info button; it
            only appears in comparison mode, where the right map is on screen. */}
        <div className="flex items-end gap-2">
          {comparisonMode && !legendMinimized && (
            <Legend
              entries={mapRightLayers.layerEntries}
              hiddenIds={mapRightLayers.hiddenIds}
              hiddenRules={mapRightLayers.hiddenRules}
              dimmedIds={mapRightLayers.dimmedIds}
              layerSteps={mapRightLayers.layerSteps}
              playingIds={mapRightLayers.playingIds}
              onToggle={handlersB.toggle}
              onToggleDim={handlersB.toggleDim}
              onToggleRule={handlersB.toggleRule}
              onTogglePlay={handlersB.togglePlay}
              onSetStep={handlersB.setStep}
              onRemove={handlersB.remove}
              onOpenMeta={openLayerMeta}
              onMove={handleMoveToLeft}
              moveDirection="left"
              onReorder={handlersB.reorder}
            />
          )}
          <MapAttribution />
        </div>
      </div>

      {/* Share button — standalone top-left when the sidebar toolbar isn't
          there to host it. */}
      {!sidebarActive && (shareButton || combineButton) && (
        <div className="absolute left-2 top-2 z-30 flex gap-1 sm:left-4 sm:top-4">
          {shareButton}
          {combineButton}
        </div>
      )}

      {/* "Lagen combineren" dialog — classes across the active layers. */}
      {combinationsEnabled && (
        <CombineLayersDialog
          key={combineSession}
          open={combineOpen}
          onOpenChange={setCombineOpen}
          layers={combinableLayers}
          onCreate={handleCreateCombination}
        />
      )}

      {/* "Delen" dialog — share link + circular PNG export. */}
      {shareEnabled && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          entries={shareSide.layerEntries}
          hiddenIds={shareSide.hiddenIds}
          hiddenRules={shareSide.hiddenRules}
          entriesA={mapLeftLayers.layerEntries}
          entriesB={mapRightLayers.layerEntries}
          hiddenIdsA={mapLeftLayers.hiddenIds}
          hiddenIdsB={mapRightLayers.hiddenIds}
          basemapId={basemapId}
          studyAreaId={studyAreaId}
          filteredStudy={filteredStudy}
          annotations={annotationsVisible ? annotations.annotations : undefined}
          viewState={viewState}
          annotRoomId={annotationActive ? collab.roomId : null}
          title={shareTitle}
          subtitle={shareSubtitle}
          onTitleChange={setShareTitle}
          onSubtitleChange={setShareSubtitle}
        />
      )}

      {/* Analytics panel — right side; opened by selecting a layer in the
          legend. In comparison mode it overlays the right map by design.
          Never shown while the annotation tool is active. */}
      {chartsPanelEnabled && chartLayerConfig && !chartsMinimized && !annotationActive && (
        <ChartsPanel
          config={chartLayerConfig}
          version={areaFilter.version + boxSelect.version}
          onClose={handleChartsClose}
          areaSelectActive={boxSelect.active}
          onToggleAreaSelect={handleAreaSelectToggle}
        />
      )}

      {/* Top-right toolbar stack: the annotation tool card and the restore
          button for the minimized statistics panel (docked where the panel
          itself lives). While the statistics panel is open it occupies the
          top-right corner, so the stack shifts left of it. */}
      {(annotationsEnabled || (chartsPanelEnabled && chartLayerConfig && chartsMinimized)) && (
        <div
          className="absolute right-2 top-2 z-30 flex flex-col items-end gap-2 sm:right-4 sm:top-4"
          style={
            chartsPanelEnabled && chartLayerConfig && !chartsMinimized && !annotationActive
              ? { right: "calc(min(30rem, 90vw) + 1.5rem)" }
              : undefined
          }
        >
          {annotationsEnabled && (
            <AnnotationToolbar
              active={annotationActive}
              drawTool={annotationDrawTool}
              onSetTool={annotationSetTool}
              onToggleMode={handleAnnotationToolToggle}
              collabRoomId={collab.roomId}
              collabPeers={collab.peers}
              collabConnected={collab.connected}
            />
          )}
          {chartsPanelEnabled && chartLayerConfig && chartsMinimized && !annotationActive && (
            <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleChartsMinimized}
                title="Statistieken tonen"
                aria-label="Statistieken tonen"
              >
                <Icon name="monitoring" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Selected-annotation chrome — titlebox + edit/info toolbuttons,
          anchored above the top of the shape. Delete/Backspace removes,
          Escape deselects. */}
      {annotationsVisible && selectedAnnotation && annotationPopupPos && (
        <AnnotationEditPopup
          // Remount on selection change so the editor's local draft state
          // (title/description/panel flags) resets with the annotation, instead
          // of being re-synced by an effect after a stale first render.
          key={selectedAnnotation.id}
          annotation={selectedAnnotation}
          x={annotationPopupPos.x}
          y={annotationPopupPos.y}
          onChange={(patch) => annotations.update(selectedAnnotation.id, patch)}
          onRecapture={() =>
            // Re-capture the FULL session snapshot — both maps' layers +
            // hidden ids, gebiedsfilters and camera — exactly like creation.
            annotations.update(selectedAnnotation.id, {
              snapshot: annotationCommands.captureSnapshot(),
            })
          }
          onDelete={() => {
            // Same as the Delete/Backspace shortcut: deselect, then remove.
            annotationSelect(null);
            annotations.remove(selectedAnnotation.id);
          }}
        />
      )}

      {/* Left column: in sidebar mode the toolbar + Filter/Navigatie card sit at
          the top and the Legenda at the bottom, in one flex column so the two
          can never overlap. The navigation's height leads; the legend takes the
          space left over below it (shrinking and scrolling inside) with the
          column's gap between them. In top mode the column holds the legend
          alone, which the spacer keeps pinned bottom-left as before.
          pointer-events-none so the empty space around the cards doesn't
          swallow map clicks — each card re-enables its own. */}
      <div className="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4 sm:top-4">
        {sidebarActive && (
          <Sidebar
            nav={nav}
            areaFilter={areaFilter}
            showFilter={filterAvailable && !navMinimized}
            showNavigation={navAvailable && !navMinimized}
            onClose={toggleNavMinimized}
            toolbar={sidebarToolbar}
            showCombinations={combinationsEnabled}
            combinationLeaves={filterLayers.leaves}
            onOpenMeta={openLayerMeta}
          />
        )}

        {/* Pushes the legend to the bottom of the column: it absorbs whatever
            the two capped cards leave over, and collapses to zero when they
            together need the full height. */}
        <div className="min-h-0 flex-1" aria-hidden />

        {/* Bottom-left, at most a quarter of the viewport. `flex-shrink` still
            lets it give way below that cap if the column runs out of room, so
            it can never overlap the navigation above. */}
        <div className="pointer-events-auto flex max-h-[25vh] min-h-0 flex-shrink flex-col items-start">
          {legendMinimized ? (
            // Collapsed bar (bottom-left → right): show-Kaartlagen toggle, then
            // the basemap toggle. Restoring re-opens the Kaartlagen window.
            <div className="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleLegendMinimized}
                title="Kaartlagen tonen"
                aria-label="Kaartlagen tonen"
              >
                <Icon name="legend_toggle" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={openBasemapDialog}
                title="Referentielagen kiezen"
                aria-label="Referentielagen kiezen"
              >
                <Icon name="map" size={chromeIconSize()} color={chromeIconColor()} />
              </Button>
            </div>
          ) : (
            <Legend
              entries={leftLegendLayers.layerEntries}
              hiddenIds={leftLegendLayers.hiddenIds}
              hiddenRules={leftLegendLayers.hiddenRules}
              dimmedIds={leftLegendLayers.dimmedIds}
              layerSteps={leftLegendLayers.layerSteps}
              playingIds={leftLegendLayers.playingIds}
              onToggle={leftLegendHandlers.toggle}
              onToggleDim={leftLegendHandlers.toggleDim}
              onToggleRule={leftLegendHandlers.toggleRule}
              onTogglePlay={leftLegendHandlers.togglePlay}
              onSetStep={leftLegendHandlers.setStep}
              onRemove={leftLegendHandlers.remove}
              onOpenMeta={openLayerMeta}
              onReorder={leftLegendHandlers.reorder}
              onMove={leftLegendUsesMapB ? handleMoveToLeft : handleMoveToRight}
              moveDirection={leftLegendUsesMapB ? "left" : "right"}
              // Moving the left map's only layer to the right map would empty the
              // left map (which anchors the comparison) — grey the button out.
              moveDisabled={!leftLegendUsesMapB && mapLeftLayers.layerEntries.length <= 1}
              onOpenBasemaps={openBasemapDialog}
              onClose={toggleLegendMinimized}
              // The slot above already applies the 20vh cap and the shrink —
              // let that bind rather than a second, independent cap here.
              maxHeightClass="max-h-full"
            />
          )}
        </div>
      </div>

      {/* Details + Street View — one window below the click, single close button */}
      {popupPoint && (pickResult || (streetview && streetView)) && (
        <InfoPopup
          x={popupPoint.x}
          y={popupPoint.y}
          title={pickResult ? "Details" : "Street View"}
          onClose={closePopup}
          wide={pickResult ? resultUsesPblSummary(pickResult, pickEntries) : false}
        >
          {pickResult && (
            <FeatureInfo result={pickResult} layerEntries={pickEntries} embedded />
          )}
          {streetview && streetView && (
            <StreetView lng={streetView.lng} lat={streetView.lat} embedded />
          )}
        </InfoPopup>
      )}

      <BasemapDialog
        open={basemapDialogOpen}
        onOpenChange={setBasemapDialogOpen}
        basemapId={basemapId}
        onSelect={setBasemap}
      />

      <LayerMetaDialog
        open={metaLayer !== null}
        onOpenChange={closeLayerMeta}
        layer={metaLayer}
        onAddLayer={addMetaLayerToLeftMap}
        isLayerOnMap={isMetaLayerOnLeftMap}
      />
    </div>
  );
}

export default App;
