import { useState, useCallback, useEffect, useRef } from "react";
import type { ViewStateChangeEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MapView, BASEMAPS, DEFAULT_BASEMAP_ID } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import { useClickMarkerLayers } from "@/hooks/use-click-marker-layer";
import { resolveMarkerPoint } from "@/lib/marker-snap";
import {
  DEFAULT_CLICK_MARKER,
  DEFAULT_MAP_CONTROLS,
  chromeIconSize,
  chromeIconColor,
  type ClickMarkerConfig,
  type MapControlsConfig,
} from "@/config/map-config";
import { useFeaturePick } from "@/hooks/use-feature-pick";
import { useHoverCursor } from "@/hooks/use-hover-cursor";
import { useUrlCommands, type ViewUpdate } from "@/hooks/use-url-commands";
import { useEmbedData, type EmbedConfig } from "@/hooks/use-embed-data";
import { useMapSnapshot } from "@/hooks/use-map-snapshot";
import { useNavigation } from "@/hooks/use-navigation";
import { useAreaFilter } from "@/hooks/use-area-filter";
import { useBoxSelect } from "@/hooks/use-box-select";
import { useSelectionBoxLayers } from "@/hooks/use-selection-box-layer";
import { isChartEligible } from "@/layers/charts";
import { Legend } from "@/components/ui/legend";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/nav-icon";
import { NavigationPanel } from "@/components/ui/navigation/NavigationPanel";
import { Sidebar } from "@/components/ui/sidebar/Sidebar";
import { SectionToggleBar, type SectionToggle } from "@/components/ui/sidebar/SectionToggleBar";
import { useSessionFlag } from "@/hooks/use-session-flag";
import { useAutoCollapse } from "@/hooks/use-auto-collapse";
import { MapControls } from "@/components/ui/map-controls";
import { MapAttribution } from "@/components/ui/map-attribution";
import { FeatureInfo } from "@/components/ui/feature-info";
import { StreetView } from "@/components/ui/street-view";
import { InfoPopup } from "@/components/ui/info-popup";
import { ComparisonSlider } from "@/components/ui/comparison-slider";
import { ChartsPanel } from "@/components/charts/ChartsPanel";
import { ShareDialog } from "@/components/share/ShareDialog";
//import { MapPills } from "@/components/ui/map-pills";

function App({
  initialViewState,
  studyAreaId,
  streetviewEnabled = false,
  searchbarEnabled = false,
  navigationEnabled = false,
  navigationMode = "top",
  filterSectionEnabled = true,
  navigationSectionEnabled = true,
  chartsPanelEnabled = true,
  shareEnabled = true,
  mapControls = DEFAULT_MAP_CONTROLS,
  clickMarker: clickMarkerConfig = DEFAULT_CLICK_MARKER,
}: {
  initialViewState: ViewState;
  studyAreaId?: string;
  streetviewEnabled?: boolean;
  searchbarEnabled?: boolean;
  navigationEnabled?: boolean;
  navigationMode?: "top" | "sidebar";
  filterSectionEnabled?: boolean;
  navigationSectionEnabled?: boolean;
  chartsPanelEnabled?: boolean;
  shareEnabled?: boolean;
  mapControls?: MapControlsConfig;
  clickMarker?: ClickMarkerConfig;
}) {
  // UI-surface flags are seeded from map.json (props) but can be overridden at
  // runtime by an embedding host (Power BI visual) via the `map-config` message.
  const [streetview, setStreetviewEnabled] = useState(streetviewEnabled);
  const [searchbar, setSearchbarEnabled] = useState(searchbarEnabled);
  const [navigation, setNavigationEnabled] = useState(navigationEnabled);
  const sidebarMode = navigationMode === "sidebar";

  const mapLeftLayers = useMapLayers();
  const mapRightLayers = useMapLayers();

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

  // Always-on study area, pinned above everything (incl. labels) on both maps.
  // Separate instances — Layer objects must not be shared across two Deck overlays.
  const studyLayersA = useStudyAreaLayer(studyAreaId);
  const studyLayersB = useStudyAreaLayer(showMapRight ? studyAreaId : undefined);
  const mapLeftRef = useRef<MapViewHandle>(null);
  const mapRightRef = useRef<MapViewHandle>(null);
  const [mapLeftReady, setMapLeftReady] = useState(false);

  const [viewState, setViewState] = useState(initialViewState);
  const [sliderPosition, setSliderPosition] = useState(50);

  // Selected background basemap (shared by both maps). The legend's map button
  // cycles through BASEMAPS; only the base style swaps — user layers stay.
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP_ID);
  const basemapIndex = Math.max(0, BASEMAPS.findIndex((b) => b.id === basemapId));
  const nextBasemap = BASEMAPS[(basemapIndex + 1) % BASEMAPS.length];
  const cycleBasemap = useCallback(() => {
    setBasemapId((prev) => {
      const i = Math.max(0, BASEMAPS.findIndex((b) => b.id === prev));
      return BASEMAPS[(i + 1) % BASEMAPS.length].id;
    });
  }, []);

  // Feature picking for each map
  const pickA = useFeaturePick(mapLeftLayers.layerEntries, mapLeftRef);
  const pickB = useFeaturePick(mapRightLayers.layerEntries, mapRightRef);

  // Hover cursor (pointer over clickable features, grab otherwise) for each map
  const hoverA = useHoverCursor(mapLeftLayers.layerEntries, mapLeftRef);
  const hoverB = useHoverCursor(mapRightLayers.layerEntries, mapRightRef);

  // Shared Street View panel — reflects the most recent click on either map
  const [streetView, setStreetView] = useState<{ lng: number; lat: number } | null>(
    null,
  );
  // Shared click marker — a single dot dropped at the most recent click on either map
  const [clickMarker, setClickMarker] = useState<{ lng: number; lat: number } | null>(
    null,
  );
  // Screen position of the most recent click — anchors the Details/Street View
  // popup just below the pointer. Both maps fill the app root, so the map-local
  // point doubles as a root-relative position.
  const [popupPoint, setPopupPoint] = useState<{ x: number; y: number } | null>(null);
  // Drop the marker (and optional Street View) at a click. When the click hit a
  // point feature, `snapped` carries that feature's location so the marker lands
  // exactly on the point; otherwise we use the raw cursor lngLat.
  const handleMapClick = useCallback(
    (e: MapLayerMouseEvent, snapped: { lng: number; lat: number } | null) => {
      const point = snapped ?? { lng: e.lngLat.lng, lat: e.lngLat.lat };
      setClickMarker(point);
      if (!streetview) return;
      setStreetView(point);
    },
    [streetview],
  );

  // Per-map marker layers (separate instances — Layer objects can't be shared
  // across two Deck overlays). Appended to each map's always-on-top topLayers.
  const markerLayersA = useClickMarkerLayers(clickMarker, clickMarkerConfig);
  const markerLayersB = useClickMarkerLayers(showMapRight ? clickMarker : null, clickMarkerConfig);

  // Area-select tool: a drawn rectangle restricting the charts/statistics to
  // rows inside it (ANDed with the area filter). One shared instance — the box
  // is a single filter shown on both maps; map rendering is unaffected.
  const boxSelect = useBoxSelect();
  const { active: boxSelectActive, toggle: boxSelectToggle } = boxSelect;
  const selectionBox = boxSelect.draft ?? boxSelect.box;
  const boxLayersA = useSelectionBoxLayers(selectionBox, "a");
  const boxLayersB = useSelectionBoxLayers(showMapRight ? selectionBox : null, "b");

  // Mirror the tool state into both maps' cursor flags (crosshair while armed).
  useEffect(() => {
    for (const handle of [mapLeftRef.current, mapRightRef.current]) {
      if (!handle) continue;
      handle.drawModeRef.current = boxSelect.active;
      const canvas = handle.mapRef.current?.getMap()?.getCanvas();
      if (canvas) canvas.style.cursor = boxSelect.active ? "crosshair" : "";
    }
  }, [boxSelect.active]);

  // Compose feature picking with Street View capture so both run per click
  const pickAClick = pickA.handleClick;
  const pickBClick = pickB.handleClick;
  const pickAClear = pickA.clear;
  const pickBClear = pickB.clear;
  const onClickA = useCallback(
    (e: MapLayerMouseEvent) => {
      // While area select is armed, clicks belong to the draw gesture (MapLibre
      // fires click after mouseup) — don't drop the marker or open FeatureInfo.
      if (boxSelectActive) return;
      pickAClick(e);
      pickBClear(); // one popup: the latest click wins
      setPopupPoint({ x: e.point.x, y: e.point.y });
      handleMapClick(e, resolveMarkerPoint(e, mapLeftRef, mapLeftLayers.layerEntries));
    },
    [boxSelectActive, pickAClick, pickBClear, handleMapClick, mapLeftLayers.layerEntries],
  );
  const onClickB = useCallback(
    (e: MapLayerMouseEvent) => {
      if (boxSelectActive) return;
      pickBClick(e);
      pickAClear();
      setPopupPoint({ x: e.point.x, y: e.point.y });
      handleMapClick(e, resolveMarkerPoint(e, mapRightRef, mapRightLayers.layerEntries));
    },
    [boxSelectActive, pickBClick, pickAClear, handleMapClick, mapRightLayers.layerEntries],
  );

  const hoverAMove = hoverA.handleMouseMove;
  const hoverBMove = hoverB.handleMouseMove;
  const boxSelectMove = boxSelect.handleMouseMove;
  const onMouseMoveA = useCallback(
    (e: MapLayerMouseEvent) => {
      hoverAMove(e);
      boxSelectMove(e);
    },
    [hoverAMove, boxSelectMove],
  );
  const onMouseMoveB = useCallback(
    (e: MapLayerMouseEvent) => {
      hoverBMove(e);
      boxSelectMove(e);
    },
    [hoverBMove, boxSelectMove],
  );

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({ mapLeftLayers, mapRightLayers, mapLeftRef, mapRightRef });

  // Gemeente/Wijk/Buurt area filter (sidebar). Selections live in a module
  // store read by the layer accessors; on change, re-clone both maps' deck
  // layers so the accessors re-evaluate.
  const areaFilter = useAreaFilter();

  // Minimize state for the whole navigation UI (Filter + Navigatie together,
  // persisted for the session). Collapsed via the close button inside the
  // navigation window, restored via the "Navigatie tonen" toolbar icon (which
  // only appears while minimized). Only relevant in sidebar mode;
  // `*SectionEnabled` (from map.json) gates availability entirely.
  const [navMinimized, setNavMinimized, toggleNavMinimized] = useSessionFlag(
    "sidebar.nav.min",
    false,
  );
  const [chartsMinimized, setChartsMinimized, toggleChartsMinimized] = useSessionFlag(
    "sidebar.charts.min",
    false,
  );
  // Minimize state for the Kaartlagen (legend) window, persisted for the
  // session. Collapsed via the close button in the window header, restored via
  // the "Kaartlagen tonen" icon in the collapsed bottom-left bar.
  const [legendMinimized, setLegendMinimized, toggleLegendMinimized] = useSessionFlag(
    "legend.min",
    false,
  );

  // On small screens, auto-collapse windows in the priority order
  // Navigatie → Statistieken → Kaartlagen as the viewport narrows. Only fires
  // when the width crosses a breakpoint, so manual toggles within a size band
  // are preserved.
  useAutoCollapse(
    useCallback(
      (t) => {
        setNavMinimized(t.nav);
        setChartsMinimized(t.charts);
        setLegendMinimized(t.legend);
      },
      [setNavMinimized, setChartsMinimized, setLegendMinimized],
    ),
  );

  // Analytics ("Analyse & statistieken") panel: selected via a layer-name
  // click in the legend; fed by the layer's attribute table restricted to the
  // current area filter.
  const [selectedChartLayerId, setSelectedChartLayerId] = useState<string | null>(null);
  const chartLayerConfig =
    (selectedChartLayerId &&
      (mapLeftLayers.layerEntries.find((e) => e.config.id === selectedChartLayerId)?.config ??
        mapRightLayers.layerEntries.find((e) => e.config.id === selectedChartLayerId)?.config)) ||
    null;
  const handleSelectChartLayer = useCallback(
    (id: string) => {
      setSelectedChartLayerId((prev) => (prev === id ? null : id));
      setChartsMinimized(false);
    },
    [setChartsMinimized],
  );
  // The selected layer was removed from both maps — close the panel.
  useEffect(() => {
    if (selectedChartLayerId && !chartLayerConfig) setSelectedChartLayerId(null);
  }, [selectedChartLayerId, chartLayerConfig]);

  // Auto-open the panel when a layer with charts/statistics is added (via
  // navigation, URL command or embed host) — the newest eligible layer wins.
  const knownLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const known = knownLayerIdsRef.current;
    const next = new Set<string>();
    let added: string | null = null;
    for (const entry of [...mapLeftLayers.layerEntries, ...mapRightLayers.layerEntries]) {
      next.add(entry.config.id);
      if (!known.has(entry.config.id) && chartsPanelEnabled && isChartEligible(entry.config)) {
        added = entry.config.id;
      }
    }
    knownLayerIdsRef.current = next;
    if (added) {
      setSelectedChartLayerId(added);
      setChartsMinimized(false);
    }
  }, [
    mapLeftLayers.layerEntries,
    mapRightLayers.layerEntries,
    chartsPanelEnabled,
    setChartsMinimized,
  ]);

  // "Delen" (share/export) dialog. The circular preview mirrors the on-screen
  // map side: B when the right map renders full-width on top (same rule as the
  // legend's mapBOnTop); comparison mode previews map A — a circular still
  // can't represent a slider comparison.
  const [shareOpen, setShareOpen] = useState(false);

  const sidebarActive = sidebarMode && navigation;
  const filterAvailable = sidebarActive && filterSectionEnabled && areaFilter.entries.length > 0;
  const navAvailable = sidebarActive && navigationSectionEnabled;

  // The navigation UI embeds the MapControls card (search + zoom) whenever it is
  // shown: the top-center panel (top mode) or the sidebar toolbar (sidebar mode).
  // When it isn't, we render a standalone card so the controls stay independent
  // of the navigation flag (map.json `mapControls`).
  const navShowsControls = sidebarActive || (navigation && !sidebarMode);

  const sectionToggles: SectionToggle[] = [];
  // Single combined toggle for the whole navigation (Filter + Navigatie). It
  // only appears while minimized — restoring the window. Closing happens via
  // the close button inside the navigation window itself.
  if ((filterAvailable || navAvailable) && navMinimized) {
    sectionToggles.push({
      key: "navigation",
      icon: "layers",
      title: "Navigatie tonen",
      active: false,
      onToggle: toggleNavMinimized,
    });
  }
  // The statistics-panel restore button lives top-right (next to where the
  // panel itself docks), not in this top-left toolbar — see the render below.

  // The chart layer went away while the tool was armed: turn it off so the box
  // doesn't linger invisibly in the filter behind a disabled button.
  useEffect(() => {
    if (boxSelectActive && !selectedChartLayerId) boxSelectToggle();
  }, [boxSelectActive, boxSelectToggle, selectedChartLayerId]);

  const refreshLeft = mapLeftLayers.refreshAreaFilter;
  const refreshRight = mapRightLayers.refreshAreaFilter;
  useEffect(() => {
    if (areaFilter.version === 0) return; // initial no-filter render
    refreshLeft(areaFilter.version);
    refreshRight(areaFilter.version);
  }, [areaFilter.version, refreshLeft, refreshRight]);

  const applyView = useCallback((view: ViewUpdate) => {
    setViewState((s) => ({
      ...s,
      ...(view.zoom !== undefined ? { zoom: view.zoom } : {}),
      ...(view.center ? { longitude: view.center[0], latitude: view.center[1] } : {}),
    }));
  }, []);

  // Process URL commands for layer management (only after the left map is ready)
  useUrlCommands({
    mapLeft: { layers: mapLeftLayers, mapRef: mapLeftRef }, // "linker kaart"
    mapRight: { layers: mapRightLayers, mapRef: mapRightRef }, // "rechter kaart"
    ready: mapLeftReady,
    applyView,
  });

  // Apply runtime UI-config overrides from an embedding host (Power BI visual).
  const applyConfig = useCallback((cfg: EmbedConfig) => {
    if (typeof cfg.searchbar === "boolean") setSearchbarEnabled(cfg.searchbar);
    if (typeof cfg.navigation === "boolean") setNavigationEnabled(cfg.navigation);
    if (typeof cfg.streetview === "boolean") setStreetviewEnabled(cfg.streetview);
  }, []);

  // In-memory data pushed by an embedding host (Power BI visual): renders on
  // the left map and posts the map-ready handshake to the parent window.
  useEmbedData({ mapLeftLayers, mapLeftRef, ready: mapLeftReady, onConfig: applyConfig });

  const hasMapLeftLayers = mapLeftLayers.layerEntries.length > 0;

  // Comparison requires layers on the left and a comparable layer on the right
  // (showMapRight, computed near the top with the B-side topLayer hooks).
  const comparisonMode = hasMapLeftLayers && showMapRight;

  // While embedded (Power BI visual), keep pushing map snapshots to the parent
  // so dashboard PDF export shows the map (the iframe itself exports blank).
  useMapSnapshot({
    mapLeftRef,
    mapRightRef,
    comparisonMode,
    sliderPosition,
    ready: mapLeftReady,
  });

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

  const handleToggleA = useCallback(
    (layerId: string) => {
      mapLeftLayers.toggleLayer(layerId, mapLeftRef.current?.mapRef ?? { current: null });
    },
    [mapLeftLayers],
  );

  const handleToggleB = useCallback(
    (layerId: string) => {
      mapRightLayers.toggleLayer(layerId, mapRightRef.current?.mapRef ?? { current: null });
    },
    [mapRightLayers],
  );

  const handleToggleRuleA = useCallback(
    (layerId: string, ruleName: string) => {
      mapLeftLayers.toggleRule(layerId, ruleName, mapLeftRef.current?.mapRef ?? { current: null });
    },
    [mapLeftLayers],
  );

  const handleToggleRuleB = useCallback(
    (layerId: string, ruleName: string) => {
      mapRightLayers.toggleRule(layerId, ruleName, mapRightRef.current?.mapRef ?? { current: null });
    },
    [mapRightLayers],
  );

  const handleRemoveA = useCallback(
    (layerId: string) => {
      mapLeftLayers.removeLayer(layerId, mapLeftRef.current?.mapRef ?? { current: null });
    },
    [mapLeftLayers],
  );

  const handleRemoveB = useCallback(
    (layerId: string) => {
      mapRightLayers.removeLayer(layerId, mapRightRef.current?.mapRef ?? { current: null });
    },
    [mapRightLayers],
  );

  // Fired once anchors + overlay are (re)loaded — on initial load and after a
  // basemap swap. setStyle wipes native MVT/COG layers, so re-add them; the
  // helpers are idempotent and skip layers/sources that already exist.
  const handleMapLeftLabelsReady = useCallback(() => {
    const ref = mapLeftRef.current?.mapRef;
    if (ref) mapLeftLayers.syncImperativeLayers(ref);
  }, [mapLeftLayers]);

  const handleMapRightLabelsReady = useCallback(() => {
    const ref = mapRightRef.current?.mapRef;
    if (ref) mapRightLayers.syncImperativeLayers(ref);
  }, [mapRightLayers]);

  // One shared popup: the latest click's pick result (the other map's pick is
  // cleared on click) plus Street View, closed together by its single button.
  const pickResult = pickA.result ?? pickB.result;
  const pickEntries = pickA.result
    ? mapLeftLayers.layerEntries
    : mapRightLayers.layerEntries;
  const closePopup = useCallback(() => {
    pickAClear();
    pickBClear();
    setStreetView(null);
    setPopupPoint(null);
  }, [pickAClear, pickBClear]);

  // The share toolbutton, rendered as its own card so it matches the sibling
  // toolbar cards. In sidebar mode it slots into the toolbar row (after the
  // nav-restore toggle, before the map controls); otherwise it stands alone
  // top-left.
  const shareButton = shareEnabled ? (
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
  ) : null;

  // On-screen side shown in the share preview/PNG (see shareOpen comment).
  const shareSide = !comparisonMode && showMapRight ? mapRightLayers : mapLeftLayers;

  const handleZoomIn = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: prev.zoom + 1 }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: Math.max(0, prev.zoom - 1) }));
  }, []);

  return (
    <div className="relative w-full h-full">
      {/* Left map — full width in single mode, clipped left in comparison */}
      <div
        className="absolute inset-0"
        style={
          comparisonMode
            ? { clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }
            : undefined
        }
      >
        <MapView
          ref={mapLeftRef}
          layers={mapLeftLayers.deckLayers}
          topLayers={[...studyLayersA, ...markerLayersA, ...boxLayersA]}
          basemapId={basemapId}
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onClick={onClickA}
          onMouseMove={onMouseMoveA}
          onMouseDown={boxSelect.handleMouseDown}
          onMouseUp={boxSelect.handleMouseUp}
          onLoad={() => setMapLeftReady(true)}
          onLabelsReady={handleMapLeftLabelsReady}
        />
      </div>

      {/* Right map — mounted whenever it has its own layers. Only clipped in
          comparison mode; otherwise renders full-width on top of the left map. */}
      {showMapRight && (
        <div
          className="absolute inset-0"
          style={
            comparisonMode
              ? { clipPath: `inset(0 0 0 ${sliderPosition}%)` }
              : undefined
          }
        >
          <MapView
            ref={mapRightRef}
            layers={mapRightLayers.deckLayers}
            topLayers={[...studyLayersB, ...markerLayersB, ...boxLayersB]}
            basemapId={basemapId}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
            onClick={onClickB}
            onMouseMove={onMouseMoveB}
            onMouseDown={boxSelect.handleMouseDown}
            onMouseUp={boxSelect.handleMouseUp}
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
        <MapAttribution />
      </div>

      {/* Sidebar mode: toolbar (search, zoom, section toggles) top left above
          the Filter + Navigatie sections */}
      {sidebarActive && (
        <Sidebar
          nav={nav}
          areaFilter={areaFilter}
          showFilter={filterAvailable && !navMinimized}
          showNavigation={navAvailable && !navMinimized}
          onClose={toggleNavMinimized}
          toolbar={
            <>
              {/* Navigation-restore toggle sits left of the map controls, so
                  reopening the navigation happens at the far-left of the row.
                  The share card follows it; map controls (search rightmost)
                  close the row. */}
              <SectionToggleBar orientation="horizontal" toggles={sectionToggles} />
              {shareButton}
              <MapControls
                orientation="horizontal"
                onZoomIn={handleZoomIn}
                onZoomOut={handleZoomOut}
                showSearch={mapControls.search}
                showZoom={mapControls.zoom}
              />
            </>
          }
        />
      )}

      {/* Share button — standalone top-left when the sidebar toolbar isn't
          there to host it. */}
      {!sidebarActive && shareButton && (
        <div className="absolute left-2 top-2 z-30 sm:left-4 sm:top-4">{shareButton}</div>
      )}

      {/* "Delen" dialog — share links/QR + circular PNG export. */}
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
          viewState={viewState}
        />
      )}

      {/* Analytics panel — right side; opened by selecting a layer in the
          legend. In comparison mode it overlays the right map by design. */}
      {chartsPanelEnabled && chartLayerConfig && !chartsMinimized && (
        <ChartsPanel
          config={chartLayerConfig}
          version={areaFilter.version + boxSelect.version}
          onClose={() => setChartsMinimized(true)}
          areaSelectActive={boxSelect.active}
          onToggleAreaSelect={boxSelect.toggle}
        />
      )}

      {/* Restore button for the minimized statistics panel — docked top-right
          where the panel itself lives, so reopening happens in the same place
          it was closed. */}
      {chartsPanelEnabled && chartLayerConfig && chartsMinimized && (
        <div className="absolute right-2 top-2 z-30 flex flex-shrink-0 gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm sm:right-4 sm:top-4">
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

      {/* Legend + FeatureInfo — bottom left, side by side with icon-button gap.
          Left edge aligns with the sidebar (Filter/Navigatie) column so the
          Kaartlagen box sits directly below them. */}
      <div
        className="absolute bottom-2 left-2 z-30 flex items-end gap-2 sm:bottom-4 sm:left-4"
      >
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
              onClick={cycleBasemap}
              title={`Achtergrondkaart: ${nextBasemap.label}`}
              aria-label="Achtergrondkaart wisselen"
            >
              <Icon name="cached" size={chromeIconSize()} color={chromeIconColor()} />
            </Button>
          </div>
        ) : (
          <Legend
            entriesA={mapLeftLayers.layerEntries}
            entriesB={mapRightLayers.layerEntries}
            hiddenIdsA={mapLeftLayers.hiddenIds}
            hiddenIdsB={mapRightLayers.hiddenIds}
            hiddenRulesA={mapLeftLayers.hiddenRules}
            hiddenRulesB={mapRightLayers.hiddenRules}
            onToggleA={handleToggleA}
            onToggleB={handleToggleB}
            onToggleRuleA={handleToggleRuleA}
            onToggleRuleB={handleToggleRuleB}
            onRemoveA={handleRemoveA}
            onRemoveB={handleRemoveB}
            comparisonMode={comparisonMode}
            mapBOnTop={showMapRight}
            selectedChartLayerId={selectedChartLayerId}
            onSelectChartLayer={handleSelectChartLayer}
            chartsEnabled={chartsPanelEnabled}
            nextBasemapLabel={nextBasemap.label}
            onCycleBasemap={cycleBasemap}
            onClose={toggleLegendMinimized}
          />
        )}
      </div>

      {/* Details + Street View — one window below the click, single close button */}
      {popupPoint && (pickResult || (streetview && streetView)) && (
        <InfoPopup
          x={popupPoint.x}
          y={popupPoint.y}
          title={pickResult ? "Details" : "Street View"}
          onClose={closePopup}
        >
          {pickResult && (
            <FeatureInfo result={pickResult} layerEntries={pickEntries} embedded />
          )}
          {streetview && streetView && (
            <StreetView lng={streetView.lng} lat={streetView.lat} embedded />
          )}
        </InfoPopup>
      )}

      {/* Kaart A/B identification pills — top left/right */}
      {/*<MapPills activeA={hasMapLeftLayers} activeB={showMapRight} />*/}
    </div>
  );
}

export default App;
