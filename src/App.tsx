import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  untrack,
  type JSX,
} from "solid-js";
import type {
  MapAccessor,
  MapViewHandle,
  ViewState,
  ViewStateChangeEvent,
} from "@/components/map/map-view-config";
import { MapView } from "@/components/map/MapView";
import { useBasemap } from "@/hooks/use-basemap";
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
import { areaFilterLevels } from "@/layers/area-filter";
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

interface AppProps {
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
}

function App(rawProps: AppProps): JSX.Element {
  // mergeProps rather than destructuring with defaults: Solid props are getters,
  // and destructuring reads them once outside any tracking scope.
  const props = mergeProps(
    {
      streetviewEnabled: false,
      searchbarEnabled: false,
      navigationEnabled: false,
      navigationMode: "top" as const,
      filterSectionEnabled: true,
      navigationSectionEnabled: true,
      chartsPanelEnabled: true,
      shareEnabled: true,
      filterFlyToEnabled: true,
      combinationsEnabled: false,
      annotationsEnabled: false,
      mapControls: DEFAULT_MAP_CONTROLS,
      clickMarker: DEFAULT_CLICK_MARKER,
      embedCircular: false,
    },
    rawProps,
  );

  // UI-surface flags come from map.json (props) but an embedding host (Power BI
  // visual) can override them at runtime via the `map-config` message. The
  // signal holds only the OVERRIDE, so the prop stays live until one arrives —
  // seeding a signal from a prop instead would silently freeze it at mount.
  const [streetviewOverride, setStreetviewEnabled] = createSignal<boolean | null>(null);
  const [searchbarOverride, setSearchbarEnabled] = createSignal<boolean | null>(null);
  const [navigationOverride, setNavigationEnabled] = createSignal<boolean | null>(null);
  const [shareOverride, setShareEnabled] = createSignal<boolean | null>(null);
  const [annotationsOverride, setAnnotationsEnabled] = createSignal<boolean | null>(null);
  const streetview = () => streetviewOverride() ?? props.streetviewEnabled;
  const searchbar = () => searchbarOverride() ?? props.searchbarEnabled;
  const navigation = () => navigationOverride() ?? props.navigationEnabled;
  const shareEnabled = () => shareOverride() ?? props.shareEnabled;
  const annotationsEnabled = () => annotationsOverride() ?? props.annotationsEnabled;
  const [combineOpen, setCombineOpen] = createSignal(false);
  const sidebarMode = () => props.navigationMode === "sidebar";

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
  // the slider. Computed up here because the B-side overlay hooks below are
  // gated on it: an overlay whose GL resources were created by the right map
  // must not outlive that map's unmount.
  const showMapRight = createMemo(() =>
    mapRightLayers.layerEntries().some((e) => !e.config.excludeFromComparison),
  );

  // Gemeente/Wijk/Buurt area filter (sidebar). Selections live in a module
  // store read by the layer accessors; on change, the native layers are
  // re-filtered (see the areaFilterLevels effect below).
  //
  // The filter's fly-to normally reaches the maps through the shared `map:flyto`
  // event, which only MOUNTED MapViews listen to. The circular-only view renders
  // without any, so there the event has no listener and the camera would never
  // follow the filter. Routing the bbox through applyView moves the circle
  // instead. In the normal app this branch is skipped so the animated MapLibre
  // flyTo stays authoritative — a hard setViewState there would replace the
  // animation with a jump.
  const areaFilter = useAreaFilter({
    // eslint-disable-next-line solid/reactivity -- map.json config, fixed for the session
    flyTo: props.filterFlyToEnabled,
    onFlyToBbox: (bbox: BBox) => {
      if (circularOnlyActive()) applyView({ bbox });
    },
  });

  const [mapLeftView, setMapLeftView] = createSignal<MapViewHandle | null>(null);
  const [mapRightView, setMapRightView] = createSignal<MapViewHandle | null>(null);
  const getMapLeft: MapAccessor = () => mapLeftView()?.map() ?? null;
  const getMapRight: MapAccessor = () => mapRightView()?.map() ?? null;

  // Always-on study area, pinned to the `studyarea-layers` anchor band on both
  // maps. While a gebiedsfilter selection is active the configured studyarea is
  // replaced by the selected gebied (finest level): a 200 km mask disc around
  // it plus the gebied outline — so the configured one is removed by passing
  // `undefined`, which native layers require.
  const filteredStudy = useFilteredStudyArea(areaFilter);
  const studyAreaA = useStudyAreaLayer(
    () => (filteredStudy() ? undefined : props.studyAreaId),
    mapLeftView,
  );
  const studyAreaB = useStudyAreaLayer(
    () => (showMapRight() && !filteredStudy() ? props.studyAreaId : undefined),
    mapRightView,
  );
  const filteredStudyA = useFilteredStudyAreaLayers(filteredStudy, mapLeftView);
  const filteredStudyB = useFilteredStudyAreaLayers(
    () => (showMapRight() ? filteredStudy() : null),
    mapRightView,
  );
  const [mapLeftReady, setMapLeftReady] = createSignal(false);

  const [viewState, setViewState] = createSignal<ViewState>(props.initialViewState);
  const [sliderPosition, setSliderPosition] = createSignal(50);

  // Selected background basemap (shared by both maps). The legend's map button
  // opens the picker; only the base style swaps — user layers stay, re-added
  // by each map's onLabelsReady below.
  const { basemapId, setBasemap } = useBasemap({
    // eslint-disable-next-line solid/reactivity -- map.json config, fixed for the session
    configDefault: props.basemapDefault,
  });
  const [basemapDialogOpen, setBasemapDialogOpen] = createSignal(false);

  // A layer's metainfo window, opened from the legend's info button or from
  // under a navigation description. Holds the layer rather than a bare id so
  // the dialog can title itself without re-resolving layers.json.
  const [metaLayer, setMetaLayer] = createSignal<{ id: string; name: string } | null>(null);

  function openLayerMeta(id: string, name: string) {
    setMetaLayer({ id, name });
  }

  function closeLayerMeta(open: boolean) {
    if (!open) setMetaLayer(null);
  }

  // Feature picking for each map
  const pickA = useFeaturePick(mapLeftLayers.layerEntries, mapLeftView);
  const pickB = useFeaturePick(mapRightLayers.layerEntries, mapRightView);

  // Feature highlighting (hover outline + the clicked feature) per map. Kept
  // per map because feature state lives on that map's own style instance.
  const highlightA = useFeatureHighlight(mapLeftView);
  const highlightB = useFeatureHighlight(mapRightView);

  // Hover cursor (pointer over clickable features, grab otherwise) for each map
  const hoverA = useHoverCursor(mapLeftLayers.layerEntries, mapLeftView, highlightA.setHovered);
  const hoverB = useHoverCursor(mapRightLayers.layerEntries, mapRightView, highlightB.setHovered);

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
  createEffect(() => {
    applySelectionHighlight(pickA.result(), highlightA.setSelected);
  });

  createEffect(() => {
    applySelectionHighlight(pickB.result(), highlightB.setSelected);
  });

  // Per-map marker overlays, drawn as MapLibre symbol layers on each map's own
  // style. map.json `clickMarker.enabled: false` (or `clickMarker: false`)
  // suppresses the marker; clicks still open popups/Street View.
  const markerPoint = () => (props.clickMarker.enabled ? clickMarker() : null);
  const clickMarkerConfig = () => props.clickMarker;
  const markerA = useClickMarkerLayers(markerPoint, mapLeftView, clickMarkerConfig);
  const markerB = useClickMarkerLayers(
    () => (showMapRight() ? markerPoint() : null),
    mapRightView,
    clickMarkerConfig,
  );

  // Area-select tool: a drawn rectangle restricting the charts/statistics to
  // rows inside it (ANDed with the area filter). One shared instance — the box
  // is a single filter shown on both maps; map rendering is unaffected.
  const boxSelect = useBoxSelect();
  const selectionBox = () => boxSelect.draft() ?? boxSelect.box();
  const boxA = useSelectionBoxLayers(selectionBox, mapLeftView);
  const boxB = useSelectionBoxLayers(
    () => (showMapRight() ? selectionBox() : null),
    mapRightView,
  );

  // Annotation tool: circles around areas of interest, each carrying a
  // title/description and a snapshot of the session (gebiedsfilters, both
  // maps' layers, camera). Annotations live in a Y.Doc from the start, so
  // sharing later just attaches a collab provider (live cursors, shared
  // edits) to the same doc — Yjs merges the local annotations into the room.
  const annotations = useAnnotations();
  const collab = useCollab(annotations.doc);
  const { startSession, setCursor, setActiveAnnotation } = collab;

  // No live-value refs for the async snapshot restore: layer adds await full
  // data loads, but every piece of state these commands read is a signal, so
  // reading it at the moment it is needed is enough.
  const annotationCommands = useAnnotationCommands({
    annotations,
    identity: collab.identity,
    areaFilter,
    mapLeftLayers,
    mapRightLayers,
    viewState,
    mapLeft: mapLeftView,
    mapRight: mapRightView,
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
  createEffect(() => {
    setActiveAnnotation(annotationSelectedId());
  });

  const selectedAnnotation = createMemo(
    () => annotations.annotations().find((a) => a.id === annotationSelectedId()) ?? null,
  );

  // The selected annotation was deleted (possibly by a peer) — close the popup.
  createEffect(() => {
    if (annotationSelectedId() && !selectedAnnotation()) annotationSelect(null);
  });

  // Screen anchor for the edit popup: the top of the selected shape (topmost
  // vertex for polygons, top of the rim for circles), projected through the
  // left map (both maps share the viewState, so the projection is identical).
  // viewState is tracked so the popup follows the shape while the map pans or
  // a snapshot restore flies.
  const annotationPopupPos = createMemo(() => {
    const annotation = selectedAnnotation();
    if (!annotation) return null;
    const map = getMapLeft();
    if (!map) return null;
    const zoom = viewState().zoom;
    const c = map.project([annotation.center.lng, annotation.center.lat]);
    if (annotation.pin) {
      // The pin icon extends upward from its anchored tip.
      return { x: c.x, y: c.y - PIN_SIZE_ACTIVE_PX };
    }
    if (isAnnotationIconified(annotation, zoom)) {
      // Far-zoom icon form: center-anchored, half the icon extends upward.
      return { x: c.x, y: c.y - PIN_SIZE_ACTIVE_PX / 2 };
    }
    if (annotation.points) {
      let minY = Infinity;
      for (const p of annotation.points) {
        const q = map.project([p.lng, p.lat]);
        if (q.y < minY) minY = q.y;
      }
      return { x: c.x, y: minY };
    }
    // Circle rim top: the radius northward from the center.
    const top = map.project([
      annotation.center.lng,
      annotation.center.lat + annotation.radiusM / METERS_PER_DEGREE_LAT,
    ]);
    return { x: c.x, y: top.y };
  });

  const annotationsVisible = () => annotationsEnabled() && annotationActive();
  const annotationsForExport = () =>
    annotationsVisible() ? annotations.annotations() : undefined;

  // Annotation bodies (shapes, icons, labels, peer cursors) render as native
  // MapLibre sources on each map's own style. iconScale 4 supersamples the
  // sprite images, declared back as `pixelRatio` — ≥ the 32-38px draw size on
  // hi-DPI screens, so pins stay crisp without a jagged downscale.
  const annotSourceA = useAnnotationSource(mapLeftView, {
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: () => collab.identity.color,
    visible: annotationsVisible,
    zoom: () => viewState().zoom,
    iconScale: () => 4,
  });
  const annotSourceB = useAnnotationSource(mapRightView, {
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: () => collab.identity.color,
    visible: () => annotationsVisible() && showMapRight(),
    zoom: () => viewState().zoom,
    iconScale: () => 4,
  });

  // Mirror the tool state into both maps' cursor flags (crosshair while armed).
  // Annotation mode alone doesn't claim the crosshair — only an armed drawing
  // tool does; without one the map navigates (and shows cursors) as usual.
  const drawToolArmed = () => boxSelect.active() || annotationDrawTool() !== null;
  createEffect(() => {
    const armed = drawToolArmed();
    for (const handle of [mapLeftView(), mapRightView()]) {
      if (!handle) continue;
      handle.setDrawMode(armed);
      const canvas = handle.map()?.getCanvas();
      if (canvas) canvas.style.cursor = armed ? "crosshair" : "";
    }
  });

  // One click, move or drag fanned out across picking, hover, area-select,
  // annotation drawing, the click marker and collab presence — plus the mutual
  // exclusion between the two draw tools.
  const pointer = useMapPointer({
    mapLeft: mapLeftView,
    mapRight: mapRightView,
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

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({
    mapLeftLayers,
    mapRightLayers,
    mapLeft: mapLeftView,
    mapRight: mapRightView,
  });

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
  let pickLayerAdded = false;
  createEffect(() => {
    if (!props.pickLayerId || !mapLeftReady() || pickLayerAdded) return;
    pickLayerAdded = true;
    const pickLayerId = props.pickLayerId;
    loadLayerConfigs()
      // async continuation: reads the
      // layer stack when the configs land, deliberately outside this effect's scope
      // eslint-disable-next-line solid/reactivity
      .then((configs) => {
        const config = getLayerConfigById(configs, pickLayerId);
        if (!config) {
          console.warn(`map.json: pickLayer "${pickLayerId}" not found in layers.json`);
          return;
        }
        void mapLeftLayers.addLayer(config, getMapLeft, { atEnd: true });
      })
      .catch((err) => {
        // Non-fatal: without it the map simply has nothing to click, which is
        // how every other config behaves.
        console.warn(`Failed to add pickLayer "${pickLayerId}":`, err);
      });
  });

  // The layer cross-references inside a layer's metainfo, which the publisher
  // still points at the retired 2025 mapviewer. Handed to LayerMetaDialog so
  // those links act on this viewer instead.
  function addMetaLayerToLeftMap(id: string) {
    // The link reads "add", never "remove": toggleOnMap would take an
    // already-visible layer back off the map, which is not what it promises.
    if (nav.isOnMap(id, "a")) return;
    void nav.toggleOnMap(id, "a");
  }

  function isMetaLayerOnLeftMap(id: string) {
    return nav.isOnMap(id, "a");
  }

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
    // eslint-disable-next-line solid/reactivity -- map.json config, fixed for the session
    chartsPanelEnabled: props.chartsPanelEnabled,
    setChartsMinimized,
    boxSelectActive: boxSelect.active,
    boxSelectToggle: boxSelect.toggle,
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

  const sidebarActive = () => sidebarMode() && navigation();
  const filterAvailable = () =>
    sidebarActive() && props.filterSectionEnabled && areaFilter.entries().length > 0;
  const navAvailable = () => sidebarActive() && props.navigationSectionEnabled;

  // The navigation UI embeds the MapControls card (search + zoom) whenever it is
  // shown: the top-center panel (top mode) or the sidebar toolbar (sidebar mode).
  // When it isn't, we render a standalone card so the controls stay independent
  // of the navigation flag (map.json `mapControls`).
  const navShowsControls = () => sidebarActive() || (navigation() && !sidebarMode());

  // Single combined toggle for the whole navigation (Filter + Navigatie). It
  // only appears while minimized — restoring the window. Closing happens via
  // the close button inside the navigation window itself.
  const sectionToggles = (): SectionToggle[] => {
    if (!(filterAvailable() || navAvailable()) || !navMinimized()) return [];
    return [
      {
        key: "navigation",
        icon: "layers",
        title: "Navigatie tonen",
        active: false,
        onToggle: toggleNavMinimized,
      },
    ];
  };
  // The statistics-panel restore button lives top-right (next to where the
  // panel itself docks), not in this top-left toolbar — see the render below.

  // Re-apply the gebiedsfilter to the native layers of both maps whenever the
  // selection changes. The module store's own signal is the trigger; the first
  // run is the initial no-filter render, which has nothing to re-apply.
  // refreshAreaFilter itself reads layerEntries, which must NOT become a
  // dependency — adding a layer already applies the filter on the way in.
  let areaFilterSeen = false;
  createEffect(() => {
    areaFilterLevels();
    if (!areaFilterSeen) {
      areaFilterSeen = true;
      return;
    }
    untrack(() => {
      // Native layers live on a specific map, so each side gets its own accessor.
      mapLeftLayers.refreshAreaFilter([getMapLeft]);
      mapRightLayers.refreshAreaFilter([getMapRight]);
    });
  });

  function applyView(view: ViewUpdate) {
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
  }

  // The circular-only view replaces the whole app: no MapView is mounted, so
  // nothing listens to `map:flyto` and nothing feeds a camera back into
  // viewState. Read by the area filter's onFlyToBbox above.
  function circularOnlyActive() {
    return props.embedCircular || (shareEnabled() && circularOpen());
  }

  // A share link with an `annot` room: enter annotation mode and join the
  // collab session directly (ignored when the feature is disabled here).
  function handleAnnotationRoom(roomId: string) {
    if (!annotationsEnabled()) return;
    annotationActivate();
    startSession(roomId);
  }

  // Host `filter` messages -> one committed gebiedsfilter selection.
  const setFilterFromHost = useHostFilter({
    areaFilter,
    applyView,
    initialViewState: props.initialViewState,
  });

  // Process URL commands for layer management (only after the left map is
  // ready). In the standalone circular embed the main left map is never
  // mounted, so gate on embedCircular too — layer entries populate without a
  // live map (ExportPreviewMap re-syncs any native MVT/COG layers itself).
  useUrlCommands({
    mapLeft: { layers: mapLeftLayers, view: mapLeftView }, // "linker kaart"
    mapRight: { layers: mapRightLayers, view: mapRightView }, // "rechter kaart"
    ready: () => mapLeftReady() || props.embedCircular,
    applyView,
    onAnnotationRoom: handleAnnotationRoom,
    onBasemap: setBasemap,
    onOpenCircular: openCircular,
    onSetFilter: setFilterFromHost,
  });

  // Apply runtime UI-config overrides from an embedding host (Power BI visual).
  function applyConfig(cfg: EmbedConfig) {
    if (typeof cfg.searchbar === "boolean") setSearchbarEnabled(cfg.searchbar);
    if (typeof cfg.navigation === "boolean") setNavigationEnabled(cfg.navigation);
    if (typeof cfg.streetview === "boolean") setStreetviewEnabled(cfg.streetview);
    if (typeof cfg.share === "boolean") setShareEnabled(cfg.share);
    if (typeof cfg.annotations === "boolean") setAnnotationsEnabled(cfg.annotations);
  }

  // In-memory data pushed by an embedding host (Power BI visual): renders on
  // the left map and posts the map-ready handshake to the parent window. In the
  // standalone circular embed the main left map is never mounted, so treat the
  // app as ready once mounted — the postMessage handlers don't need a live map.
  useEmbedData({
    mapLeftLayers,
    mapLeft: mapLeftView,
    ready: () => mapLeftReady() || props.embedCircular,
    onConfig: applyConfig,
  });

  // Comparison requires layers on the left and a comparable layer on the right
  // (showMapRight, computed near the top with the B-side overlay hooks).
  const comparisonMode = () => mapLeftLayers.layerEntries().length > 0 && showMapRight();

  // Legend placement. The bottom-left legend belongs to the map shown on that
  // side: map A normally, but map B when it renders full-width on top with no
  // left-map layers (mapBOnTop, outside comparison mode). The bottom-right
  // legend (map B) only appears in comparison mode, when both maps are visible.
  const leftLegendUsesMapB = () => !comparisonMode() && showMapRight();

  // While embedded (Power BI visual), keep pushing map snapshots to the parent
  // so dashboard PDF export shows the map (the iframe itself exports blank).
  useMapSnapshot({
    mapLeft: mapLeftView,
    mapRight: mapRightView,
    comparisonMode,
    sliderPosition,
    ready: mapLeftReady,
  });

  // The left map is the primary one, so its first load is the moment the app
  // has something real to show — that is when the boot splash comes down.
  function handleMapLeftLoad() {
    setMapLeftReady(true);
    dismissSplash();
  }

  // Once the right map's MapLibre style is loaded, replay any imperative MVT/COG
  // entries that addLayer attempted before the map existed. Idempotent.
  function handleMapRightLoad() {
    mapRightLayers.syncImperativeLayers(getMapRight);
  }

  function handleMove(evt: ViewStateChangeEvent) {
    setViewState((prev) => ({
      ...prev,
      ...evt.viewState,
      pitch: 0,
      bearing: 0,
    }));
  }

  // One set of legend/UI callbacks per map, bound to that map's layer stack and
  // handle. Also owns each map's timeseries playback timers.
  const handlersA = useLayerHandlers(mapLeftLayers, mapLeftView);
  const handlersB = useLayerHandlers(mapRightLayers, mapRightView);

  // Whichever map the bottom-left legend is driving — resolved once so that
  // Legend reads one pair of values instead of repeating the same test per prop.
  const leftLegendLayers = () => (leftLegendUsesMapB() ? mapRightLayers : mapLeftLayers);
  const leftLegendHandlers = () => (leftLegendUsesMapB() ? handlersB : handlersA);

  // Move a layer between maps: re-add its config to the destination map, then
  // remove it from the source. The layer's config is the source of truth for
  // which map it lives on, so the legend button icon follows automatically.
  function handleMoveToRight(layerId: string) {
    const entry = mapLeftLayers.layerEntries().find((e) => e.config.id === layerId);
    if (!entry) return;
    void mapRightLayers.addLayer(entry.config, getMapRight);
    mapLeftLayers.removeLayer(layerId, getMapLeft);
  }

  function handleMoveToLeft(layerId: string) {
    const entry = mapRightLayers.layerEntries().find((e) => e.config.id === layerId);
    if (!entry) return;
    void mapLeftLayers.addLayer(entry.config, getMapLeft);
    mapRightLayers.removeLayer(layerId, getMapRight);
  }

  // Fired once anchors + overlay are (re)loaded — on initial load and after a
  // basemap swap. setStyle wipes native MVT/COG layers, so re-add them; the
  // helpers are idempotent and skip layers/sources that already exist.
  // Each imperative overlay owns its own re-add: they live outside
  // useMapLayers, so a basemap swap would otherwise drop them silently.
  function handleMapLeftLabelsReady() {
    mapLeftLayers.syncImperativeLayers(getMapLeft);
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
  }

  function handleMapRightLabelsReady() {
    mapRightLayers.syncImperativeLayers(getMapRight);
    // See handleMapLeftLabelsReady: the style swap took the feature state with it.
    highlightB.clearAll();
    studyAreaB.resync();
    filteredStudyB.resync();
    markerB.resync();
    boxB.resync();
    annotSourceB.resync();
  }

  function handleZoomIn() {
    setViewState((prev) => ({ ...prev, zoom: prev.zoom + 1 }));
  }

  function handleZoomOut() {
    setViewState((prev) => ({ ...prev, zoom: Math.max(0, prev.zoom - 1) }));
  }

  /**
   * The share toolbutton, rendered as its own card so it matches the sibling
   * toolbar cards. In sidebar mode it slots into the toolbar row (after the
   * nav-restore toggle, before the map controls); otherwise it stands alone
   * top-left. A component rather than a shared element: a DOM node can only be
   * in one place, and both call sites have to be able to render it.
   */
  function ShareButton(): JSX.Element {
    return (
      <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
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
    );
  }

  // The Combinaties theme appears only once a combination exists. An empty
  // category would otherwise sit in the tree for every session, promising a
  // feature the user reaches from the legend instead — and the theme's whole
  // purpose is to list what has been created.
  const showCombinationsTheme = () =>
    props.combinationsEnabled && filterLayers.leaves().length > 0;

  function handleCreateCombination(name: string, refs: ClassRef[]) {
    // Inputs come from the legend's stack (what the dialog offered), but the
    // result always lands on the LEFT map — `useFilterLayers` is bound to that
    // stack's addLayer/removeLayer, and a combination is one new layer that
    // has to belong to exactly one map.
    const legend = leftLegendLayers();
    const configs = legend.layerEntries().map((entry) => entry.config);
    // Same stack the configs came from, so a timeseries layer's raster cannot
    // resolve to a step the dialog never showed.
    const stepFor = (layerId: string) => legend.layerSteps().get(layerId);
    // Fire-and-forget: reading and scoring the rasters takes a moment, and the
    // hook surfaces both progress and failure through its own state.
    void filterLayers.create(name, refs, configs, [getMapLeft], stepFor);
  }

  // Layers offered for combining: those the LEGEND is showing that define
  // classes AND have a companion class raster. Tied to the legend's own stack
  // because the button now sits in its header — offering layers the user cannot
  // see there would be arbitrary. `filterRaster` is required because the score
  // is computed cell-by-cell off that shared grid, so a layer without one has
  // nothing to contribute.
  const combinableLayers = createMemo(() =>
    leftLegendLayers()
      .layerEntries()
      .map((entry) => entry.config)
      .filter(
        (config) => (config.geostyler?.rules?.length ?? 0) > 0 && config.filterRaster,
      ),
  );

  // On-screen side shown in the share preview/PNG (see shareOpen comment).
  const shareSide = () => (!comparisonMode() && showMapRight() ? mapRightLayers : mapLeftLayers);

  // Legend rows for the circular export view (same flattening the dialog +
  // PNG use). Cheap; recomputed when the shown side's layers/visibility change.
  const circularLegendItems = () =>
    legendItemsForEntries(
      shareSide().layerEntries(),
      shareSide().hiddenIds(),
      shareSide().hiddenRules(),
    );

  return (
    // Circular-only view: NOTHING but the circle + legend + title, centered on a
    // white page — no map chrome, toolbar, sidebar or backdrop. Rendered both for
    // the standalone `?embed=circular` page and when a host `open-circular`
    // message requests it (the message-driven case gets a close button to return
    // to the full app). This replaces the whole app rather than overlaying it.
    <Show
      when={!circularOnlyActive()}
      fallback={
        <div class="relative flex h-full w-full items-center justify-center bg-white">
          {/* No close button in standalone embed mode — it's the whole page. */}
          <Show when={!props.embedCircular}>
            <Button
              variant="ghost"
              size="icon-sm"
              class="absolute right-3 top-3 z-10"
              onClick={() => setCircularOpen(false)}
              title="Sluiten"
              aria-label="Sluiten"
            >
              <Icon name="close" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
          </Show>
          {/* size="fill" sizes the circle to the viewport itself — no width cap
              here. Deliberately NOT re-created per layer set: that would tear
              down the MapLibre instance and refetch the basemap, sprites and
              tiles on every layer switch. The point of the postMessage API is
              that swapping layers adds/removes just those layers, so
              ExportPreviewMap reconciles its own layer set from `entries`
              instead (and adopts camera changes through initialViewState). */}
          <CircularExportView
            entries={shareSide().layerEntries()}
            hiddenIds={shareSide().hiddenIds()}
            hiddenRules={shareSide().hiddenRules()}
            basemapId={basemapId()}
            studyAreaId={props.studyAreaId}
            filteredStudy={filteredStudy()}
            annotations={annotationsForExport()}
            initialViewState={viewState()}
            legendItems={circularLegendItems()}
            title={shareTitle()}
            subtitle={shareSubtitle()}
            mode="display"
            size="fill"
          />
        </div>
      }
    >
      <div class="relative w-full h-full">
        {/* Left map — full width in single mode, clipped left in comparison */}
        <div
          class="absolute inset-0 touch-none"
          style={
            comparisonMode()
              ? { "clip-path": `inset(0 ${100 - sliderPosition()}% 0 0)` }
              : undefined
          }
        >
          <MapView
            ref={setMapLeftView}
            basemapId={basemapId()}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState()}
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
        <Show when={showMapRight()}>
          <div
            class="absolute inset-0 touch-none"
            style={
              comparisonMode()
                ? { "clip-path": `inset(0 0 0 ${sliderPosition()}%)` }
                : undefined
            }
          >
            <MapView
              ref={setMapRightView}
              basemapId={basemapId()}
              style={{ width: "100%", height: "100%" }}
              viewState={viewState()}
              onMove={handleMove}
              onClick={pointer.b.onClick}
              onMouseMove={pointer.b.onMouseMove}
              onMouseDown={pointer.b.onMouseDown}
              onMouseUp={pointer.onMouseUp}
              onLoad={handleMapRightLoad}
              onLabelsReady={handleMapRightLabelsReady}
            />
          </div>
        </Show>

        {/* Comparison slider */}
        <Show when={comparisonMode()}>
          <ComparisonSlider
            position={sliderPosition()}
            onPositionChange={setSliderPosition}
          />
        </Show>

        {/* Navigation menu — top center (includes map controls: search, +, -).
            In sidebar mode only the search bar remains here. */}
        <NavigationPanel
          nav={nav}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          showSearch={searchbar()}
          showNavigation={navigation() && !sidebarMode()}
          showControlsSearch={props.mapControls.search}
          showControlsZoom={props.mapControls.zoom}
          showCombinations={showCombinationsTheme()}
          combinationLeaves={filterLayers.leaves()}
          onOpenMeta={openLayerMeta}
        />

        {/* Bottom-right stack: standalone map controls (search + zoom, only
            when the navigation UI isn't already showing the MapControls card)
            above the map-attribution info button, which replaces MapLibre's
            default attribution control. */}
        <div class="absolute bottom-2 right-2 z-30 flex flex-col items-end gap-2 sm:bottom-4 sm:right-4">
          <Show
            when={
              !navShowsControls() && (props.mapControls.search || props.mapControls.zoom)
            }
          >
            <MapControls
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              showSearch={props.mapControls.search}
              showZoom={props.mapControls.zoom}
            />
          </Show>
          {/* Right-map legend sits to the left of the attribution info button; it
              only appears in comparison mode, where the right map is on screen. */}
          <div class="flex items-end gap-2">
            <Show when={comparisonMode() && !legendMinimized()}>
              <Legend
                entries={mapRightLayers.layerEntries()}
                hiddenIds={mapRightLayers.hiddenIds()}
                hiddenRules={mapRightLayers.hiddenRules()}
                dimmedIds={mapRightLayers.dimmedIds()}
                layerSteps={mapRightLayers.layerSteps()}
                playingIds={mapRightLayers.playingIds()}
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
            </Show>
            <MapAttribution />
          </div>
        </div>

        {/* Share button — standalone top-left when the sidebar toolbar isn't
            there to host it. */}
        <Show when={!sidebarActive() && shareEnabled()}>
          <div class="absolute left-2 top-2 z-30 sm:left-4 sm:top-4">
            <ShareButton />
          </div>
        </Show>

        {/* "Lagen combineren" dialog — classes across the active layers. Mounted
            only while open, so each opening starts from a clean selection. */}
        <Show when={props.combinationsEnabled && combineOpen()}>
          <CombineLayersDialog
            open
            onOpenChange={setCombineOpen}
            layers={combinableLayers()}
            stepFor={(layerId) => leftLegendLayers().layerSteps().get(layerId)}
            onCreate={handleCreateCombination}
          />
        </Show>

        {/* "Delen" dialog — share link + circular PNG export. */}
        <Show when={shareEnabled()}>
          <ShareDialog
            open={shareOpen()}
            onOpenChange={setShareOpen}
            entries={shareSide().layerEntries()}
            hiddenIds={shareSide().hiddenIds()}
            hiddenRules={shareSide().hiddenRules()}
            entriesA={mapLeftLayers.layerEntries()}
            entriesB={mapRightLayers.layerEntries()}
            hiddenIdsA={mapLeftLayers.hiddenIds()}
            hiddenIdsB={mapRightLayers.hiddenIds()}
            basemapId={basemapId()}
            studyAreaId={props.studyAreaId}
            filteredStudy={filteredStudy()}
            annotations={annotationsForExport()}
            viewState={viewState()}
            annotRoomId={annotationActive() ? collab.roomId() : null}
            title={shareTitle()}
            subtitle={shareSubtitle()}
            onTitleChange={setShareTitle}
            onSubtitleChange={setShareSubtitle}
          />
        </Show>

        {/* Analytics panel — right side; opened by selecting a layer in the
            legend. In comparison mode it overlays the right map by design.
            Never shown while the annotation tool is active. */}
        <Show
          when={
            props.chartsPanelEnabled &&
            !chartsMinimized() &&
            !annotationActive() &&
            chartLayerConfig()
          }
        >
          {(config) => (
            <ChartsPanel
              config={config()}
              onClose={handleChartsClose}
              areaSelectActive={boxSelect.active()}
              onToggleAreaSelect={pointer.toggleAreaSelect}
            />
          )}
        </Show>

        {/* Top-right toolbar stack: the annotation tool card and the restore
            button for the minimized statistics panel (docked where the panel
            itself lives). While the statistics panel is open it occupies the
            top-right corner, so the stack shifts left of it. */}
        <Show
          when={
            annotationsEnabled() ||
            (props.chartsPanelEnabled && chartLayerConfig() && chartsMinimized())
          }
        >
          <div
            class="absolute right-2 top-2 z-30 flex flex-col items-end gap-2 sm:right-4 sm:top-4"
            style={
              props.chartsPanelEnabled &&
              chartLayerConfig() &&
              !chartsMinimized() &&
              !annotationActive()
                ? { right: "calc(min(30rem, 90vw) + 1.5rem)" }
                : undefined
            }
          >
            <Show when={annotationsEnabled()}>
              <AnnotationToolbar
                active={annotationActive()}
                drawTool={annotationDrawTool()}
                onSetTool={annotationSetTool}
                onToggleMode={pointer.toggleAnnotationTool}
                collabRoomId={collab.roomId()}
                collabPeers={collab.peers()}
                collabConnected={collab.connected()}
              />
            </Show>
            <Show
              when={
                props.chartsPanelEnabled &&
                chartLayerConfig() &&
                chartsMinimized() &&
                !annotationActive()
              }
            >
              <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
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
            </Show>
          </div>
        </Show>

        {/* Selected-annotation chrome — titlebox + edit/info toolbuttons,
            anchored above the top of the shape. Delete/Backspace removes,
            Escape deselects.

            Keyed on the annotation id so selecting another annotation MOUNTS a
            fresh popup: its local draft state (title/description, panel flags)
            then initialises from the new annotation instead of being re-synced
            by an effect after a stale first render. */}
        <Show when={annotationsVisible() ? annotationSelectedId() : null} keyed>
          {(selectedId) => (
            <Show when={selectedAnnotation()}>
              {(annotation) => (
                <Show when={annotationPopupPos()}>
                  {(pos) => (
                    <AnnotationEditPopup
                      annotation={annotation()}
                      x={pos().x}
                      y={pos().y}
                      onChange={(patch) => annotations.update(selectedId, patch)}
                      onRecapture={() =>
                        // Re-capture the FULL session snapshot — both maps' layers +
                        // hidden ids, gebiedsfilters and camera — exactly like creation.
                        annotations.update(selectedId, {
                          snapshot: annotationCommands.captureSnapshot(),
                        })
                      }
                      onDelete={() => {
                        // Same as the Delete/Backspace shortcut: deselect, then remove.
                        annotationSelect(null);
                        annotations.remove(selectedId);
                      }}
                    />
                  )}
                </Show>
              )}
            </Show>
          )}
        </Show>

        {/* Left column: in sidebar mode the toolbar + Filter/Navigatie card sit at
            the top and the Legenda at the bottom, in one flex column so the two
            can never overlap. The navigation's height leads; the legend takes the
            space left over below it (shrinking and scrolling inside) with the
            column's gap between them. In top mode the column holds the legend
            alone, which the spacer keeps pinned bottom-left as before.
            pointer-events-none so the empty space around the cards doesn't
            swallow map clicks — each card re-enables its own. */}
        <div class="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4 sm:top-4">
          <Show when={sidebarActive()}>
            <Sidebar
              nav={nav}
              areaFilter={areaFilter}
              showFilter={filterAvailable() && !navMinimized()}
              showNavigation={navAvailable() && !navMinimized()}
              onClose={toggleNavMinimized}
              toolbar={
                <>
                  {/* Navigation-restore toggle sits left of the map controls, so
                      reopening the navigation happens at the far-left of the row.
                      The share card follows it; map controls (search rightmost)
                      close the row. */}
                  <SectionToggleBar orientation="horizontal" toggles={sectionToggles()} />
                  <Show when={shareEnabled()}>
                    <ShareButton />
                  </Show>
                  <MapControls
                    orientation="horizontal"
                    onZoomIn={handleZoomIn}
                    onZoomOut={handleZoomOut}
                    showSearch={props.mapControls.search}
                    showZoom={props.mapControls.zoom}
                  />
                </>
              }
              showCombinations={showCombinationsTheme()}
              combinationLeaves={filterLayers.leaves()}
              onOpenMeta={openLayerMeta}
            />
          </Show>

          {/* Pushes the legend to the bottom of the column: it absorbs whatever
              the two capped cards leave over, and collapses to zero when they
              together need the full height. */}
          <div class="min-h-0 flex-1" aria-hidden />

          {/* Bottom-left, at most a quarter of the viewport. `flex-shrink` still
              lets it give way below that cap if the column runs out of room, so
              it can never overlap the navigation above. */}
          <div class="pointer-events-auto flex max-h-[25vh] min-h-0 flex-shrink flex-col items-start">
            <Show
              when={!legendMinimized()}
              fallback={
                // Collapsed bar (bottom-left → right): show-Kaartlagen toggle, then
                // the basemap toggle. Restoring re-opens the Kaartlagen window.
                <div class="flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleLegendMinimized}
                    title="Kaartlagen tonen"
                    aria-label="Kaartlagen tonen"
                  >
                    <Icon
                      name="legend_toggle"
                      size={chromeIconSize()}
                      color={chromeIconColor()}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setBasemapDialogOpen(true)}
                    title="Referentielagen kiezen"
                    aria-label="Referentielagen kiezen"
                  >
                    <Icon name="map" size={chromeIconSize()} color={chromeIconColor()} />
                  </Button>
                </div>
              }
            >
              <Legend
                entries={leftLegendLayers().layerEntries()}
                hiddenIds={leftLegendLayers().hiddenIds()}
                hiddenRules={leftLegendLayers().hiddenRules()}
                dimmedIds={leftLegendLayers().dimmedIds()}
                layerSteps={leftLegendLayers().layerSteps()}
                playingIds={leftLegendLayers().playingIds()}
                onToggle={leftLegendHandlers().toggle}
                onToggleDim={leftLegendHandlers().toggleDim}
                onToggleRule={leftLegendHandlers().toggleRule}
                onTogglePlay={leftLegendHandlers().togglePlay}
                onSetStep={leftLegendHandlers().setStep}
                onRemove={leftLegendHandlers().remove}
                onOpenMeta={openLayerMeta}
                onReorder={leftLegendHandlers().reorder}
                onMove={leftLegendUsesMapB() ? handleMoveToLeft : handleMoveToRight}
                moveDirection={leftLegendUsesMapB() ? "left" : "right"}
                // Moving the left map's only layer to the right map would empty the
                // left map (which anchors the comparison) — grey the button out.
                moveDisabled={
                  !leftLegendUsesMapB() && mapLeftLayers.layerEntries().length <= 1
                }
                onOpenBasemaps={() => setBasemapDialogOpen(true)}
                onOpenCombine={
                  props.combinationsEnabled ? () => setCombineOpen(true) : undefined
                }
                canCombine={combinableLayers().length > 0}
                onClose={toggleLegendMinimized}
                // The slot above already applies the 25vh cap and the shrink —
                // let that bind rather than a second, independent cap here.
                maxHeightClass="max-h-full"
              />
            </Show>
          </div>
        </div>

        {/* Details + Street View — one window below the click, single close button */}
        <Show
          when={popupPoint() && (pickResult() || (streetview() && streetView()))}
        >
          <InfoPopup
            x={popupPoint()!.x}
            y={popupPoint()!.y}
            title={pickResult() ? "Details" : "Street View"}
            onClose={closePopup}
            wide={
              pickResult() ? resultUsesPblSummary(pickResult()!, pickEntries()) : false
            }
          >
            <Show when={pickResult()}>
              {(result) => (
                <FeatureInfo result={result()} layerEntries={pickEntries()} embedded />
              )}
            </Show>
            <Show when={streetview() && streetView()}>
              {(sv) => <StreetView lng={sv().lng} lat={sv().lat} embedded />}
            </Show>
          </InfoPopup>
        </Show>

        <BasemapDialog
          open={basemapDialogOpen()}
          onOpenChange={setBasemapDialogOpen}
          basemapId={basemapId()}
          onSelect={setBasemap}
        />

        <LayerMetaDialog
          open={metaLayer() !== null}
          onOpenChange={closeLayerMeta}
          layer={metaLayer()}
          onAddLayer={addMetaLayerToLeftMap}
          isLayerOnMap={isMetaLayerOnLeftMap}
        />
      </div>
    </Show>
  );
}

export default App;
