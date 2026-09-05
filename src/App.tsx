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
import { useComplementaryDashboard } from "@/hooks/use-complementary-dashboard";
import { viewForBbox } from "@/lib/fly-to";
import { areaFilterLevels } from "@/layers/area-filter";
import type { BBox } from "@/layers/box-filter";
import type { LayerConfig, ScoreClass } from "@/layers";
import { addPickLayer } from "@/lib/pick-layer";
import {
  DEFAULT_CLICK_MARKER,
  DEFAULT_MAP_CONTROLS,
  chromeIconSize,
  chromeIconColor,
  modelUrls,
  speechToTextEnabled,
  textToToolEnabled,
  type ClickMarkerConfig,
  type MapControlsConfig,
} from "@/config/map-config";
import { createModelLoader } from "@/ai/model-loader";
import { useFeaturePick } from "@/hooks/use-feature-pick";
import type { FeatureInfoResult } from "@/hooks/use-feature-pick";
import { useClickPopup } from "@/hooks/use-click-popup";
import { useHoverCursor } from "@/hooks/use-hover-cursor";
import { useFeatureHighlight } from "@/hooks/use-feature-highlight";
import { useUrlCommands, type ViewUpdate } from "@/hooks/use-url-commands";
import { useVariantSwitch } from "@/hooks/use-variant-switch";
import { forSide, type MapSide, type MapSideId, type MapSidePair } from "@/lib/map-side";
import { useLayerPairs } from "@/hooks/use-layer-pairs";
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
import { SearchBar } from "@/components/ui/SearchBar";
import { Sidebar } from "@/components/ui/sidebar/Sidebar";
import { SectionToggleBar, type SectionToggle } from "@/components/ui/sidebar/SectionToggleBar";
import { usePanelMinimize } from "@/hooks/use-panel-minimize";
import { MapControls } from "@/components/ui/map-controls";
import type { GeocodeResult } from "@/tools/geocode/types";
import { MapAttribution } from "@/components/ui/map-attribution";
import { FeatureInfo } from "@/components/ui/feature-info";
import { StreetView } from "@/components/ui/street-view";
import { InfoPopup } from "@/components/ui/info-popup";
import { BasemapDialog } from "@/components/ui/BasemapDialog";
import { CompareBar } from "@/components/dashboard/CompareBar";
import { ComparePanel } from "@/components/dashboard/ComparePanel";
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
  pickLayerId?: string;
  /** Pick layer for the right map; falls back to `pickLayerId` when omitted. */
  pickLayerRightId?: string;
  streetviewEnabled?: boolean;
  searchbarEnabled?: boolean;
  navigationEnabled?: boolean;
  filterSectionEnabled?: boolean;
  navigationSectionEnabled?: boolean;
  chartsPanelEnabled?: boolean;
  shareEnabled?: boolean;
  /** Open the "Over de applicatie" guide on this browser's first visit. */
  showGuideOnFirstVisit?: boolean;
  /** Open the guide's Verschilkaart tab the first time comparison mode starts. */
  showVerschilkaartOnFirstUse?: boolean;
  filterFlyToEnabled?: boolean;
  combinationsEnabled?: boolean;
  complementaryDashboardEnabled?: boolean;
  annotationsEnabled?: boolean;
  mapControls?: MapControlsConfig;
  clickMarker?: ClickMarkerConfig;
  basemapDefault?: string;
  embedCircular?: boolean;
}

function App(rawProps: AppProps): JSX.Element {
  const props = mergeProps(
    {
      streetviewEnabled: false,
      searchbarEnabled: false,
      navigationEnabled: false,
      filterSectionEnabled: true,
      navigationSectionEnabled: true,
      chartsPanelEnabled: true,
      shareEnabled: true,
      showGuideOnFirstVisit: false,
      showVerschilkaartOnFirstUse: false,
      filterFlyToEnabled: true,
      combinationsEnabled: false,
      complementaryDashboardEnabled: false,
      annotationsEnabled: false,
      mapControls: DEFAULT_MAP_CONTROLS,
      clickMarker: DEFAULT_CLICK_MARKER,
      embedCircular: false,
    },
    rawProps,
  );

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

  // Ahead of the layer stacks, which bind to these at construction.
  const [mapLeftView, setMapLeftView] = createSignal<MapViewHandle | null>(null);
  const [mapRightView, setMapRightView] = createSignal<MapViewHandle | null>(null);
  const getMapLeft: MapAccessor = () => mapLeftView()?.map() ?? null;
  const getMapRight: MapAccessor = () => mapRightView()?.map() ?? null;

  const mapLeftLayers = useMapLayers(getMapLeft);
  const mapRightLayers = useMapLayers(getMapRight);

  const mapSides: MapSidePair<MapSide> = {
    left: { layers: mapLeftLayers },
    right: { layers: mapRightLayers },
  };

  const filterLayers = useFilterLayers(
    mapLeftLayers.addLayer,
    mapLeftLayers.removeLayer,
  );

  const showMapRight = createMemo(() =>
    mapRightLayers.layerEntries().some((e) => !e.config.excludeFromComparison),
  );

  const areaFilter = useAreaFilter({
    flyTo: props.filterFlyToEnabled,
    onFlyToBbox: (bbox: BBox) => {
      if (circularOnlyActive()) applyView({ bbox });
    },
  });

  const filteredStudy = useFilteredStudyArea(areaFilter);
  // The configured study area stays up while a gebiedsfilter is active: the
  // filter draws its selection as a dashed outline OVER it rather than
  // replacing it. (This used to pass `undefined` — i.e. remove — and hand the
  // band to the filtered study area instead.)
  const studyAreaA = useStudyAreaLayer(() => props.studyAreaId, mapLeftView);
  const studyAreaB = useStudyAreaLayer(
    () => (showMapRight() ? props.studyAreaId : undefined),
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
  const { basemapId, setBasemap } = useBasemap({
    // eslint-disable-next-line solid/reactivity -- map.json config, fixed for the session
    configDefault: props.basemapDefault,
  });
  const [basemapDialogOpen, setBasemapDialogOpen] = createSignal(false);
  const [metaLayer, setMetaLayer] = createSignal<{ id: string; name: string } | null>(null);

  function openLayerMeta(id: string, name: string) {
    setMetaLayer({ id, name });
  }

  function closeLayerMeta(open: boolean) {
    if (!open) setMetaLayer(null);
  }

  const pickA = useFeaturePick(mapLeftLayers.layerEntries, mapLeftView);
  const pickB = useFeaturePick(mapRightLayers.layerEntries, mapRightView);
  const highlightA = useFeatureHighlight(mapLeftView);
  const highlightB = useFeatureHighlight(mapRightView);
  const hoverA = useHoverCursor(
    mapLeftLayers.layerEntries,
    mapLeftView,
    highlightA.setHovered,
    (point) => compare?.isSelectableAt(point) ?? false,
  );
  const hoverB = useHoverCursor(mapRightLayers.layerEntries, mapRightView, highlightB.setHovered);

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

  createEffect(() => {
    applySelectionHighlight(pickA.result(), highlightA.setSelected);
  });

  createEffect(() => {
    applySelectionHighlight(pickB.result(), highlightB.setSelected);
  });

  const markerPoint = () => (props.clickMarker.enabled ? clickMarker() : null);
  const clickMarkerConfig = () => props.clickMarker;
  const markerA = useClickMarkerLayers(markerPoint, mapLeftView, clickMarkerConfig);
  const markerB = useClickMarkerLayers(
    () => (showMapRight() ? markerPoint() : null),
    mapRightView,
    clickMarkerConfig,
  );

  const boxSelect = useBoxSelect();
  const selectionBox = () => boxSelect.draft() ?? boxSelect.box();
  const boxA = useSelectionBoxLayers(selectionBox, mapLeftView);
  const boxB = useSelectionBoxLayers(
    () => (showMapRight() ? selectionBox() : null),
    mapRightView,
  );

  const annotations = useAnnotations();
  const collab = useCollab(annotations.doc);
  const { startSession, setCursor, setActiveAnnotation } = collab;

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

  createEffect(() => {
    setActiveAnnotation(annotationSelectedId());
  });

  const selectedAnnotation = createMemo(
    () => annotations.annotations().find((a) => a.id === annotationSelectedId()) ?? null,
  );

  createEffect(() => {
    if (annotationSelectedId() && !selectedAnnotation()) annotationSelect(null);
  });

  const annotationPopupPos = createMemo(() => {
    const annotation = selectedAnnotation();
    if (!annotation) return null;
    const map = getMapLeft();
    if (!map) return null;
    const zoom = viewState().zoom;
    const c = map.project([annotation.center.lng, annotation.center.lat]);
    if (annotation.pin) {
      return { x: c.x, y: c.y - PIN_SIZE_ACTIVE_PX };
    }
    if (isAnnotationIconified(annotation, zoom)) {
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

    const top = map.project([
      annotation.center.lng,
      annotation.center.lat + annotation.radiusM / METERS_PER_DEGREE_LAT,
    ]);
    return { x: c.x, y: top.y };
  });

  const annotationsVisible = () => annotationsEnabled() && annotationActive();
  const annotationsForExport = () =>
    annotationsVisible() ? annotations.annotations() : undefined;

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

  const compare = props.complementaryDashboardEnabled
    ? useComplementaryDashboard(
        mapLeftView,
        mapLeftLayers.layerEntries,
        mapLeftLayers.addLayer,
        mapLeftReady,
      )
    : null;

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
    compareClick: compare ? (e) => compare.handleClick(e) : undefined,
    setCursor,
    setPopupPoint,
    handleMapClick,
  });

  // Which layers were applied together as a comparison. Reads the live stacks,
  // so a pair whose half left by any other route stops counting as one.
  const layerPairs = useLayerPairs((id, side) =>
    forSide(mapSides, side).layers.layerEntries().some((e) => e.config.id === id),
  );

  const nav = useNavigation({ ...mapSides, pairs: layerPairs });

  /**
   * Natural-language commands for the search bar.
   *
   * The models are downloaded lazily (see `createModelLoader`), so this is
   * wired up unconditionally and simply has no parser until one arrives —
   * `runCommand` falls back to a location search in that case, which is exactly
   * what this bar did before the feature existed.
   */
  const models = createModelLoader({
    map: () => mapLeftView()?.map() ?? null,
    textToTool: textToToolEnabled(),
    speechToText: speechToTextEnabled(),
    urls: modelUrls(),
  });

  /**
   * Place candidates for the search box's dropdown.
   *
   * Deliberately NOT routed through `handleCommand`: this is the location
   * affordance, and it must stay independent of the command engine so that
   * typing a layer command still reaches the model rather than a geocoder.
   */
  async function handleSuggest(query: string, signal: AbortSignal) {
    const { geocode } = await import("@/tools/geocode");
    return geocode(query, undefined, signal);
  }

  /** Fly to the candidate the user picked out of the dropdown. */
  async function handlePickLocation(result: GeocodeResult) {
    const { flyToResult } = await import("@/tools/zoom-to-location");
    await flyToResult(result);
  }

  async function handleCommand(text: string): Promise<string | null> {
    // Imported lazily so the command glue stays out of the entry bundle, the
    // same rule dashboard/duckdb-engine.ts states for DuckDB.
    const { runCommand } = await import("@/ai/command-engine");

    // Null until the weights have arrived, which is the ordinary case on the
    // first few commands. `runCommand` then treats the text as a place name,
    // exactly as this bar behaved before the feature existed.
    let parser = null;
    const weights = models.needleWeights();
    if (weights) {
      try {
        const { ensureNeedle } = await import("@/ai/needle-engine");
        parser = await ensureNeedle(weights);
      } catch (err) {
        console.warn("Needle unavailable; falling back to location search:", err);
      }
    }

    const result = await runCommand(
      text,
      {
        side: mapSides.left,
        right: mapSides.right,
        // The pair-aware close, so "zet apotheek uit" takes a paired layer's
        // partner off the other map exactly as the legend's close button does.
        removeLayer: removeFromSide,
        leftHasLayers: nav.leftHasLayers,
      },
      parser,
    );
    return result.ok ? null : (result.message ?? null);
  }

  /**
   * Start dictation, resolving to the finished utterance.
   *
   * Resolves rather than streaming: the caller puts the text in the input and
   * submits it, so one utterance is one command. Rejecting is meaningful too —
   * a denied microphone must reach the user, not vanish.
   */
  async function handleDictate(onPartial: (text: string) => void): Promise<string> {
    const weights = models.voskWeights();
    if (!weights) throw new Error("Het spraakmodel is nog niet geladen.");

    const { startDictation } = await import("@/ai/vosk-engine");
    return new Promise<string>((resolve, reject) => {
      void startDictation(weights, {
        onPartial,
        onResult: (text) => {
          dictation?.stop();
          dictation = null;
          resolve(text);
        },
        onError: (message) => {
          dictation?.stop();
          dictation = null;
          reject(new Error(message));
        },
      })
        .then((session) => (dictation = session))
        .catch(reject);
    });
  }

  /** The running dictation, so a second click can stop it. */
  let dictation: { stop: () => void } | null = null;

  function handleStopDictation() {
    dictation?.stop();
    dictation = null;
  }

  /**
   * The right map's pick layer, which only differs where the two maps show
   * different datasets — the `2025_2026` variant, whose right map is 2026 while
   * the left is 2025. Everywhere else this is the same layer as the left map's,
   * which is what `pickLayer` alone has always meant.
   */
  const pickLayerRightId = () => props.pickLayerRightId ?? props.pickLayerId;

  /**
   * Re-add the pick layer to every mounted map, after a variant switch cleared
   * both stacks.
   *
   * The right map is conditionally rendered, so it gets one only when it is
   * actually up; if it is not, `handleMapRightLoad` adds one whenever it next
   * appears.
   */
  function resetPickLayers() {
    void addPickLayer(mapSides.left, props.pickLayerId);
    if (mapRightView()) {
      void addPickLayer(mapSides.right, pickLayerRightId(), props.pickLayerId);
    }
  }

  // Only the first ready map triggers this; re-adds after a variant switch come
  // from useVariantSwitch, which knows it just removed the layer.
  let pickLayerStarted = false;
  createEffect(() => {
    if (!mapLeftReady() || pickLayerStarted) return;
    pickLayerStarted = true;
    void addPickLayer(mapSides.left, props.pickLayerId);
  });

  function addMetaLayerToLeftMap(id: string) {
    if (nav.isOnMap(id, "left")) return;
    void nav.toggleOnMap(id, "left");
  }

  function isMetaLayerOnLeftMap(id: string) {
    return nav.isOnMap(id, "left");
  }

  const {
    navMinimized,
    toggleNavMinimized,
    chartsMinimized,
    setChartsMinimized,
    toggleChartsMinimized,
    legendMinimized,
    toggleLegendMinimized,
  } = usePanelMinimize();

  const { chartLayerConfig, handleChartsClose } = useChartsPanel({
    mapLeftLayers,
    mapRightLayers,
    chartsPanelEnabled: props.chartsPanelEnabled,
    setChartsMinimized,
    boxSelectActive: boxSelect.active,
    boxSelectToggle: boxSelect.toggle,
  });

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

  // The sidebar IS the navigation UI, so `navigation` gates it directly; the
  // Filter and Navigatie sections then have their own keys on top of that.
  const filterAvailable = () =>
    navigation() && props.filterSectionEnabled && areaFilter.entries().length > 0;
  const navAvailable = () => navigation() && props.navigationSectionEnabled;
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

  let areaFilterSeen = false;
  createEffect(() => {
    areaFilterLevels();
    if (!areaFilterSeen) {
      areaFilterSeen = true;
      return;
    }
    untrack(() => {
      mapLeftLayers.refreshAreaFilter();
      mapRightLayers.refreshAreaFilter();
    });
  });

  function applyView(view: ViewUpdate) {
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

  function circularOnlyActive() {
    return props.embedCircular || (shareEnabled() && circularOpen());
  }

  function handleAnnotationRoom(roomId: string) {
    if (!annotationsEnabled()) return;
    annotationActivate();
    startSession(roomId);
  }

  const setFilterFromHost = useHostFilter({
    areaFilter,
    applyView,
    initialViewState: props.initialViewState,
  });

  const { switchVariant } = useVariantSwitch({
    ...mapSides,
    onResetPickLayer: resetPickLayers,
    onClearPairs: layerPairs.clear,
  });

  useUrlCommands({
    ...mapSides,
    ready: () => mapLeftReady() || props.embedCircular,
    applyView,
    onAnnotationRoom: handleAnnotationRoom,
    onBasemap: setBasemap,
    onOpenCircular: openCircular,
    onSetFilter: setFilterFromHost,
    onSetVariant: switchVariant,
  });

  function applyConfig(cfg: EmbedConfig) {
    if (typeof cfg.searchbar === "boolean") setSearchbarEnabled(cfg.searchbar);
    if (typeof cfg.navigation === "boolean") setNavigationEnabled(cfg.navigation);
    if (typeof cfg.streetview === "boolean") setStreetviewEnabled(cfg.streetview);
    if (typeof cfg.share === "boolean") setShareEnabled(cfg.share);
    if (typeof cfg.annotations === "boolean") setAnnotationsEnabled(cfg.annotations);
  }

  useEmbedData({
    mapLeftLayers,
    mapLeft: mapLeftView,
    ready: () => mapLeftReady() || props.embedCircular,
    onConfig: applyConfig,
  });

  const comparisonMode = () => mapLeftLayers.layerEntries().length > 0 && showMapRight();
  const leftLegendUsesMapB = () => !comparisonMode() && showMapRight();

  useMapSnapshot({
    mapLeft: mapLeftView,
    mapRight: mapRightView,
    comparisonMode,
    sliderPosition,
    ready: mapLeftReady,
  });

  function handleMapLeftLoad() {
    setMapLeftReady(true);
    dismissSplash();
  }

  function handleMapRightLoad() {
    mapRightLayers.syncImperativeLayers();
    // The right map is mounted only while it has a layer, so this is where it
    // first exists. Idempotent, so a later re-mount adds nothing.
    void addPickLayer(mapSides.right, pickLayerRightId(), props.pickLayerId);
  }

  function handleMove(evt: ViewStateChangeEvent) {
    setViewState((prev) => ({
      ...prev,
      ...evt.viewState,
      pitch: 0,
      bearing: 0,
    }));
  }

  const handlersA = useLayerHandlers(mapLeftLayers);
  const handlersB = useLayerHandlers(mapRightLayers);

  const leftLegendLayers = () => (leftLegendUsesMapB() ? mapRightLayers : mapLeftLayers);
  // Which map the main legend is actually acting on: it shows the right map's
  // stack when the left map is empty, so pair lookups must follow it there.
  const leftLegendSide = (): MapSideId => (leftLegendUsesMapB() ? "right" : "left");
  const leftLegendHandlers = () => (leftLegendUsesMapB() ? handlersB : handlersA);
  /**
   * Remove a layer from one map, taking its partner with it when it is half of
   * a pair — a comparison is one thing, so closing either side closes both.
   *
   * Wrapped here rather than inside `removeLayer`, which belongs to a single
   * map and cannot see the other one. Every legend's close button routes
   * through this.
   */
  function removeFromSide(layerId: string, side: MapSideId) {
    const pair = layerPairs.pairFor(layerId, side);
    if (!pair) {
      forSide(mapSides, side).layers.removeLayer(layerId);
      return;
    }

    // Forget BEFORE removing. The two calls below re-enter nothing today, but
    // the pair must not still be resolvable while its halves are coming off:
    // any future close path that consults `pairFor` would then try to remove
    // the partner again.
    layerPairs.forget(pair);
    mapLeftLayers.removeLayer(pair.left);
    mapRightLayers.removeLayer(pair.right);
  }

  function handleMoveToRight(layerId: string) {
    const entry = mapLeftLayers.layerEntries().find((e) => e.config.id === layerId);
    if (!entry) return;
    void mapRightLayers.addLayer(entry.config);
    mapLeftLayers.removeLayer(layerId);
  }

  function handleMoveToLeft(layerId: string) {
    const entry = mapRightLayers.layerEntries().find((e) => e.config.id === layerId);
    if (!entry) return;
    void mapLeftLayers.addLayer(entry.config);
    mapRightLayers.removeLayer(layerId);
  }

  function handleMapLeftLabelsReady() {
    mapLeftLayers.syncImperativeLayers();
    highlightA.clearAll();
    studyAreaA.resync();
    filteredStudyA.resync();
    markerA.resync();
    boxA.resync();
    annotSourceA.resync();
  }

  function handleMapRightLabelsReady() {
    mapRightLayers.syncImperativeLayers();
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

  const showCombinationsTheme = () =>
    props.combinationsEnabled && filterLayers.leaves().length > 0;

  function handleCreateCombination(name: string, refs: ClassRef[], classes: ScoreClass[]) {

    const legend = leftLegendLayers();
    const configs = legend.layerEntries().map((entry) => entry.config);
    const stepFor = (layerId: string) => legend.layerSteps().get(layerId);
    void filterLayers.create(name, refs, configs, stepFor, classes);
  }

  const combinableLayers = createMemo(() =>
    leftLegendLayers()
      .layerEntries()
      .map((entry) => entry.config)
      .filter(
        (config) => (config.geostyler?.rules?.length ?? 0) > 0 && config.filterRaster,
      ),
  );

  const shareSide = () => (!comparisonMode() && showMapRight() ? mapRightLayers : mapLeftLayers);
  const circularLegendItems = () =>
    legendItemsForEntries(
      shareSide().layerEntries(),
      shareSide().hiddenIds(),
      shareSide().hiddenRules(),
    );

  return (
    <Show
      when={!circularOnlyActive()}
      fallback={
        <div class="relative flex h-full w-full items-center justify-center bg-white">
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

        <Show when={comparisonMode()}>
          <ComparisonSlider
            position={sliderPosition()}
            onPositionChange={setSliderPosition}
          />
        </Show>

        <SearchBar showSearch={searchbar()} />

        <div class="absolute bottom-2 right-2 z-30 flex flex-col items-end gap-2 sm:bottom-4 sm:right-4">
          {/* Fallback for a nav-less map: with no sidebar there is no toolbar to
              carry the zoom/search card, so it sits in the corner instead. */}
          <Show
            when={!navigation() && (props.mapControls.search || props.mapControls.zoom)}
          >
            <MapControls
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              showSearch={props.mapControls.search}
              showZoom={props.mapControls.zoom}
              onCommand={handleCommand}
              onSuggest={handleSuggest}
              onPick={handlePickLocation}
              models={models}
              onDictate={handleDictate}
              onStopDictation={handleStopDictation}
            />
          </Show>

          {/* The right map's legend, in comparison mode. The enclosing column
              already right-aligns it; it used to share a row with the info
              button, which now lives in the chrome toolbar beside share. */}
          <Show when={comparisonMode() && !legendMinimized()}>
            <Legend
              entries={mapRightLayers.layerEntries()}
              hiddenIds={mapRightLayers.hiddenIds()}
              hiddenRules={mapRightLayers.hiddenRules()}
              dimmedIds={mapRightLayers.dimmedIds()}
              layerSteps={mapRightLayers.layerSteps()}
              playingIds={mapRightLayers.playingIds()}
              onToggle={mapRightLayers.toggleLayer}
              onToggleDim={mapRightLayers.toggleDim}
              onToggleRule={mapRightLayers.toggleRule}
              onTogglePlay={mapRightLayers.togglePlay}
              onSetStep={handlersB.setStep}
              onRemove={(id) => removeFromSide(id, "right")}
              onOpenMeta={openLayerMeta}
              onMove={handleMoveToLeft}
              canMove={(id) => !layerPairs.isPaired(id, "right")}
              moveDirection="left"
              onReorder={mapRightLayers.reorderLayer}
            />
          </Show>
        </div>

        {/* Chrome row for a map with navigation disabled — with the sidebar gone,
            its toolbar copy of these goes too. Not gated on `shareEnabled()`: the
            info button lives here as well, and must survive a project that turns
            sharing off. */}
        <Show when={!navigation()}>
          <div class="absolute left-2 top-2 z-30 flex items-center gap-2 sm:left-4 sm:top-4">
            <Show when={shareEnabled()}>
              <ShareButton />
            </Show>
            <MapAttribution
              autoOpen={props.showGuideOnFirstVisit}
              showVerschilkaartOnFirstUse={props.showVerschilkaartOnFirstUse}
              comparisonActive={comparisonMode()}
            />
          </div>
        </Show>

        <Show when={props.combinationsEnabled && combineOpen()}>
          <CombineLayersDialog
            open
            onOpenChange={setCombineOpen}
            layers={combinableLayers()}
            stepFor={(layerId) => leftLegendLayers().layerSteps().get(layerId)}
            onCreate={handleCreateCombination}
          />
        </Show>

        <Show when={shareEnabled()}>
          <ShareDialog
            open={shareOpen()}
            onOpenChange={setShareOpen}
            entries={shareSide().layerEntries()}
            hiddenIds={shareSide().hiddenIds()}
            hiddenRules={shareSide().hiddenRules()}
            sides={{
              left: {
                entries: mapLeftLayers.layerEntries(),
                hiddenIds: mapLeftLayers.hiddenIds(),
              },
              right: {
                entries: mapRightLayers.layerEntries(),
                hiddenIds: mapRightLayers.hiddenIds(),
              },
            }}
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
                        annotations.update(selectedId, {
                          snapshot: annotationCommands.captureSnapshot(),
                        })
                      }
                      onDelete={() => {
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

        <Show when={compare}>
          {(dashboard) => (
            <div class="pointer-events-none absolute bottom-2 left-1/2 z-30 flex w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2 sm:bottom-4">
              <Show when={dashboard().panelOpen() && dashboard().config()}>
                {(config) => (
                  <ComparePanel
                    config={config()}
                    codeColumn={dashboard().codeColumn()}
                    onClose={() => dashboard().closePanel()}
                    onRemove={(slot) => dashboard().removeSlot(slot)}
                  />
                )}
              </Show>
              <CompareBar
                onOpen={() => dashboard().openPanel()}
                onClear={() => dashboard().clearAll()}
              />
            </div>
          )}
        </Show>

        <div class="pointer-events-none absolute bottom-2 left-2 top-2 z-30 flex flex-col items-start gap-2 sm:bottom-4 sm:left-4 sm:top-4">
          <Show when={navigation()}>
            <Sidebar
              nav={nav}
              areaFilter={areaFilter}
              showFilter={filterAvailable() && !navMinimized()}
              showNavigation={navAvailable() && !navMinimized()}
              onClose={toggleNavMinimized}
              toolbar={
                <>
                  <SectionToggleBar orientation="horizontal" toggles={sectionToggles()} />
                  <Show when={shareEnabled()}>
                    <ShareButton />
                  </Show>
                  {/* Outside the shareEnabled guard: map information must stay
                      reachable in a project that turns sharing off. */}
                  <MapAttribution
                    autoOpen={props.showGuideOnFirstVisit}
                    showVerschilkaartOnFirstUse={props.showVerschilkaartOnFirstUse}
                    comparisonActive={comparisonMode()}
                  />
                  <MapControls
                    orientation="horizontal"
                    onCommand={handleCommand}
                    onSuggest={handleSuggest}
                    onPick={handlePickLocation}
                    models={models}
                    onDictate={handleDictate}
                    onStopDictation={handleStopDictation}
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

          <div class="min-h-0 flex-1" aria-hidden />
          <div class="pointer-events-auto flex max-h-[25vh] min-h-0 flex-shrink flex-col items-start">
            <Show
              when={!legendMinimized()}
              fallback={
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
                onToggle={leftLegendLayers().toggleLayer}
                onToggleDim={leftLegendLayers().toggleDim}
                onToggleRule={leftLegendLayers().toggleRule}
                onTogglePlay={leftLegendLayers().togglePlay}
                onSetStep={leftLegendHandlers().setStep}
                onRemove={(id) => removeFromSide(id, leftLegendSide())}
                onOpenMeta={openLayerMeta}
                onReorder={leftLegendLayers().reorderLayer}
                onMove={leftLegendUsesMapB() ? handleMoveToLeft : handleMoveToRight}
                canMove={(id) => !layerPairs.isPaired(id, leftLegendSide())}
                moveDirection={leftLegendUsesMapB() ? "left" : "right"}
                moveDisabled={
                  !leftLegendUsesMapB() && mapLeftLayers.layerEntries().length <= 1
                }
                onOpenBasemaps={() => setBasemapDialogOpen(true)}
                onOpenCombine={
                  props.combinationsEnabled ? () => setCombineOpen(true) : undefined
                }
                canCombine={combinableLayers().length > 0}
                onClose={toggleLegendMinimized}
                maxHeightClass="max-h-full"
              />
            </Show>
          </div>
        </div>
        
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
