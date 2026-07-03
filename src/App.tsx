import { useState, useCallback, useRef } from "react";
import type { ViewStateChangeEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MapView } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import { useClickMarkerLayers } from "@/hooks/use-click-marker-layer";
import { resolveMarkerPoint } from "@/lib/marker-snap";
import { DEFAULT_CLICK_MARKER, type ClickMarkerConfig } from "@/config/map-config";
import { useFeaturePick } from "@/hooks/use-feature-pick";
import { useHoverCursor } from "@/hooks/use-hover-cursor";
import { useUrlCommands, type ViewUpdate } from "@/hooks/use-url-commands";
import { useEmbedData, type EmbedConfig } from "@/hooks/use-embed-data";
import { useNavigation } from "@/hooks/use-navigation";
import { Legend } from "@/components/ui/legend";
import { NavigationPanel } from "@/components/ui/navigation/NavigationPanel";
import { FeatureInfo } from "@/components/ui/feature-info";
import { StreetView } from "@/components/ui/street-view";
import { ComparisonSlider } from "@/components/ui/comparison-slider";
//import { MapPills } from "@/components/ui/map-pills";

function App({
  initialViewState,
  studyAreaId,
  streetviewEnabled = false,
  searchbarEnabled = false,
  navigationEnabled = false,
  clickMarker: clickMarkerConfig = DEFAULT_CLICK_MARKER,
}: {
  initialViewState: ViewState;
  studyAreaId?: string;
  streetviewEnabled?: boolean;
  searchbarEnabled?: boolean;
  navigationEnabled?: boolean;
  clickMarker?: ClickMarkerConfig;
}) {
  // UI-surface flags are seeded from map.json (props) but can be overridden at
  // runtime by an embedding host (Power BI visual) via the `map-config` message.
  const [streetview, setStreetviewEnabled] = useState(streetviewEnabled);
  const [searchbar, setSearchbarEnabled] = useState(searchbarEnabled);
  const [navigation, setNavigationEnabled] = useState(navigationEnabled);

  const mapLeftLayers = useMapLayers();
  const mapRightLayers = useMapLayers();

  // Always-on study area, pinned above everything (incl. labels) on both maps.
  // Separate instances — Layer objects must not be shared across two Deck overlays.
  const studyLayersA = useStudyAreaLayer(studyAreaId);
  const studyLayersB = useStudyAreaLayer(studyAreaId);
  const mapLeftRef = useRef<MapViewHandle>(null);
  const mapRightRef = useRef<MapViewHandle>(null);
  const [mapLeftReady, setMapLeftReady] = useState(false);

  const [viewState, setViewState] = useState(initialViewState);
  const [sliderPosition, setSliderPosition] = useState(50);

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
  const markerLayersB = useClickMarkerLayers(clickMarker, clickMarkerConfig);

  // Compose feature picking with Street View capture so both run per click
  const onClickA = useCallback(
    (e: MapLayerMouseEvent) => {
      pickA.handleClick(e);
      handleMapClick(e, resolveMarkerPoint(e, mapLeftRef, mapLeftLayers.layerEntries));
    },
    [pickA.handleClick, handleMapClick, mapLeftLayers.layerEntries],
  );
  const onClickB = useCallback(
    (e: MapLayerMouseEvent) => {
      pickB.handleClick(e);
      handleMapClick(e, resolveMarkerPoint(e, mapRightRef, mapRightLayers.layerEntries));
    },
    [pickB.handleClick, handleMapClick, mapRightLayers.layerEntries],
  );

  const onMouseMoveA = useCallback(
    (e: MapLayerMouseEvent) => hoverA.handleMouseMove(e),
    [hoverA.handleMouseMove],
  );
  const onMouseMoveB = useCallback(
    (e: MapLayerMouseEvent) => hoverB.handleMouseMove(e),
    [hoverB.handleMouseMove],
  );

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({ mapLeftLayers, mapRightLayers, mapLeftRef, mapRightRef });

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
  const hasMapRightLayers = mapRightLayers.layerEntries.length > 0;

  // Comparison requires the right map to contain at least one non-flagged layer.
  const hasComparableLayerOnRight = mapRightLayers.layerEntries.some(
    (e) => !e.config.excludeFromComparison,
  );

  const comparisonMode = hasMapLeftLayers && hasMapRightLayers && hasComparableLayerOnRight;
  // Mount the right map only when it has a comparable layer — a flagged-only
  // right map has nothing meaningful to compare and is hidden with the slider.
  const showMapRight = hasMapRightLayers && hasComparableLayerOnRight;

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

  const handleMapLeftLabelsReady = useCallback(() => {
    const ref = mapLeftRef.current?.mapRef;
    if (ref) mapLeftLayers.applyLabelBeforeId(ref);
  }, [mapLeftLayers]);

  const handleMapRightLabelsReady = useCallback(() => {
    const ref = mapRightRef.current?.mapRef;
    if (ref) mapRightLayers.applyLabelBeforeId(ref);
  }, [mapRightLayers]);

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
          topLayers={[...studyLayersA, ...markerLayersA]}
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onClick={onClickA}
          onMouseMove={onMouseMoveA}
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
            topLayers={[...studyLayersB, ...markerLayersB]}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
            onClick={onClickB}
            onMouseMove={onMouseMoveB}
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

      {/* Navigation menu — top center (includes map controls: search, +, -) */}
      <NavigationPanel
        nav={nav}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        showSearch={searchbar}
        showNavigation={navigation}
      />

      {/* Legend + FeatureInfo — bottom left, side by side with icon-button gap */}
      <div className="absolute bottom-2 left-2 z-30 flex items-end gap-2 sm:bottom-4 sm:left-4">
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
        />

        {/* FeatureInfo popups */}
        {pickA.result && (
          <FeatureInfo
            result={pickA.result}
            layerEntries={mapLeftLayers.layerEntries}
            onClose={pickA.clear}
          />
        )}
        {pickB.result && (
          <FeatureInfo
            result={pickB.result}
            layerEntries={mapRightLayers.layerEntries}
            onClose={pickB.clear}
          />
        )}

        {/* Street View — to the right of FeatureInfo, shared across maps */}
        {streetview && streetView && (
          <StreetView
            lng={streetView.lng}
            lat={streetView.lat}
            onClose={() => setStreetView(null)}
          />
        )}
      </div>

      {/* Kaart A/B identification pills — top left/right */}
      {/*<MapPills activeA={hasMapLeftLayers} activeB={showMapRight} />*/}
    </div>
  );
}

export default App;
