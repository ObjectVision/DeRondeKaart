import { useState, useCallback, useRef } from "react";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapView } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import { useFeaturePick } from "@/hooks/use-feature-pick";
import { useUrlCommands, type ViewUpdate } from "@/hooks/use-url-commands";
import { useNavigation } from "@/hooks/use-navigation";
import { Legend } from "@/components/ui/legend";
import { NavigationPanel } from "@/components/ui/navigation/NavigationPanel";
import { FeatureInfo } from "@/components/ui/feature-info";
import { MapControls } from "@/components/ui/map-controls";
import { ComparisonSlider } from "@/components/ui/comparison-slider";
import { MapPills } from "@/components/ui/map-pills";

function App({
  initialViewState,
  studyAreaId,
}: {
  initialViewState: ViewState;
  studyAreaId?: string;
}) {
  const mapALayers = useMapLayers();
  const mapBLayers = useMapLayers();

  // Always-on study area, pinned above everything (incl. labels) on both maps.
  // Separate instances — Layer objects must not be shared across two Deck overlays.
  const studyLayersA = useStudyAreaLayer(studyAreaId);
  const studyLayersB = useStudyAreaLayer(studyAreaId);
  const mapARef = useRef<MapViewHandle>(null);
  const mapBRef = useRef<MapViewHandle>(null);
  const [mapAReady, setMapAReady] = useState(false);

  const [viewState, setViewState] = useState(initialViewState);
  const [sliderPosition, setSliderPosition] = useState(50);

  // Feature picking for each map
  const pickA = useFeaturePick(mapALayers.layerEntries, mapARef);
  const pickB = useFeaturePick(mapBLayers.layerEntries, mapBRef);

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({ mapALayers, mapBLayers, mapARef, mapBRef });

  const applyView = useCallback((view: ViewUpdate) => {
    setViewState((s) => ({
      ...s,
      ...(view.zoom !== undefined ? { zoom: view.zoom } : {}),
      ...(view.center ? { longitude: view.center[0], latitude: view.center[1] } : {}),
    }));
  }, []);

  // Process URL commands for layer management (only after Map A is ready)
  useUrlCommands({
    mapA: { layers: mapALayers, mapRef: mapARef },
    mapB: { layers: mapBLayers, mapRef: mapBRef },
    ready: mapAReady,
    applyView,
  });

  const hasMapALayers = mapALayers.layerEntries.length > 0;
  const hasMapBLayers = mapBLayers.layerEntries.length > 0;

  // Comparison requires Map B to contain at least one non-flagged layer.
  const hasComparableLayerOnB = mapBLayers.layerEntries.some(
    (e) => !e.config.excludeFromComparison,
  );

  const comparisonMode = hasMapALayers && hasMapBLayers && hasComparableLayerOnB;
  // Mount Map B only when it has a comparable layer — flagged-only B has nothing
  // meaningful to compare and is hidden alongside the slider.
  const showMapB = hasMapBLayers && hasComparableLayerOnB;

  // Once Map B's MapLibre style is loaded, replay any imperative MVT/COG
  // entries that addLayer attempted before the map existed. Idempotent.
  const handleMapBLoad = useCallback(() => {
    const ref = mapBRef.current?.mapRef;
    if (ref) mapBLayers.syncImperativeLayers(ref);
  }, [mapBLayers]);

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
      mapALayers.toggleLayer(layerId, mapARef.current?.mapRef ?? { current: null });
    },
    [mapALayers],
  );

  const handleToggleB = useCallback(
    (layerId: string) => {
      mapBLayers.toggleLayer(layerId, mapBRef.current?.mapRef ?? { current: null });
    },
    [mapBLayers],
  );

  const handleToggleRuleA = useCallback(
    (layerId: string, ruleName: string) => {
      mapALayers.toggleRule(layerId, ruleName, mapARef.current?.mapRef ?? { current: null });
    },
    [mapALayers],
  );

  const handleToggleRuleB = useCallback(
    (layerId: string, ruleName: string) => {
      mapBLayers.toggleRule(layerId, ruleName, mapBRef.current?.mapRef ?? { current: null });
    },
    [mapBLayers],
  );

  const handleMapALabelsReady = useCallback(() => {
    const ref = mapARef.current?.mapRef;
    if (ref) mapALayers.applyLabelBeforeId(ref);
  }, [mapALayers]);

  const handleMapBLabelsReady = useCallback(() => {
    const ref = mapBRef.current?.mapRef;
    if (ref) mapBLayers.applyLabelBeforeId(ref);
  }, [mapBLayers]);

  const handleZoomIn = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: prev.zoom + 1 }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewState((prev) => ({ ...prev, zoom: Math.max(0, prev.zoom - 1) }));
  }, []);

  return (
    <div className="relative w-full h-full">
      {/* Map A — full width in single mode, clipped left in comparison */}
      <div
        className="absolute inset-0"
        style={
          comparisonMode
            ? { clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }
            : undefined
        }
      >
        <MapView
          ref={mapARef}
          layers={mapALayers.deckLayers}
          topLayers={studyLayersA}
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onClick={pickA.handleClick}
          onLoad={() => setMapAReady(true)}
          onLabelsReady={handleMapALabelsReady}
        />
      </div>

      {/* Map B — mounted whenever B has its own layers. Only clipped in
          comparison mode; otherwise renders full-width on top of A. */}
      {showMapB && (
        <div
          className="absolute inset-0"
          style={
            comparisonMode
              ? { clipPath: `inset(0 0 0 ${sliderPosition}%)` }
              : undefined
          }
        >
          <MapView
            ref={mapBRef}
            layers={mapBLayers.deckLayers}
            topLayers={studyLayersB}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
            onClick={pickB.handleClick}
            onLoad={handleMapBLoad}
            onLabelsReady={handleMapBLabelsReady}
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

      {/* Navigation menu — top center */}
      <NavigationPanel nav={nav} />

      {/* Legend + FeatureInfo — bottom left, side by side with icon-button gap */}
      <div className="absolute bottom-2 left-2 z-30 flex items-end gap-2 sm:bottom-4 sm:left-4">
        <Legend
          entriesA={mapALayers.layerEntries}
          entriesB={mapBLayers.layerEntries}
          hiddenIdsA={mapALayers.hiddenIds}
          hiddenIdsB={mapBLayers.hiddenIds}
          hiddenRulesA={mapALayers.hiddenRules}
          hiddenRulesB={mapBLayers.hiddenRules}
          onToggleA={handleToggleA}
          onToggleB={handleToggleB}
          onToggleRuleA={handleToggleRuleA}
          onToggleRuleB={handleToggleRuleB}
          comparisonMode={comparisonMode}
        />

        {/* FeatureInfo popups */}
        {pickA.result && (
          <FeatureInfo
            result={pickA.result}
            layerEntries={mapALayers.layerEntries}
            onClose={pickA.clear}
          />
        )}
        {pickB.result && (
          <FeatureInfo
            result={pickB.result}
            layerEntries={mapBLayers.layerEntries}
            onClose={pickB.clear}
          />
        )}
      </div>

      {/* Map controls — bottom right */}
      <MapControls onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />

      {/* Kaart A/B identification pills — top left/right */}
      <MapPills activeA={hasMapALayers} activeB={showMapB} />
    </div>
  );
}

export default App;
