import { useState, useCallback, useRef } from "react";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapView, INITIAL_VIEW_STATE } from "@/components/map/MapView";
import type { MapViewHandle } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useUrlCommands } from "@/hooks/use-url-commands";
import { Legend } from "@/components/ui/legend";
import { MapControls } from "@/components/ui/map-controls";
import { ComparisonSlider } from "@/components/ui/comparison-slider";

function App() {
  const mapALayers = useMapLayers();
  const mapBLayers = useMapLayers();
  const mapARef = useRef<MapViewHandle>(null);
  const mapBRef = useRef<MapViewHandle>(null);
  const [mapAReady, setMapAReady] = useState(false);

  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [sliderPosition, setSliderPosition] = useState(50);

  // Process URL commands for layer management (only after Map A is ready)
  useUrlCommands({
    mapA: { layers: mapALayers, mapRef: mapARef },
    mapB: { layers: mapBLayers, mapRef: mapBRef },
    ready: mapAReady,
  });

  const hasMapALayers = mapALayers.layerEntries.length > 0;
  const hasMapBLayers = mapBLayers.layerEntries.length > 0;
  const comparisonMode = hasMapALayers && hasMapBLayers;

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
      mapALayers.toggleRule(layerId, ruleName);
    },
    [mapALayers],
  );

  const handleToggleRuleB = useCallback(
    (layerId: string, ruleName: string) => {
      mapBLayers.toggleRule(layerId, ruleName);
    },
    [mapBLayers],
  );

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
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onLoad={() => setMapAReady(true)}
        />
      </div>

      {/* Map B — only rendered in comparison mode, clipped right */}
      {comparisonMode && (
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
        >
          <MapView
            ref={mapBRef}
            layers={mapBLayers.deckLayers}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
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

      {/* Legend — bottom left */}
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

      {/* Map controls — bottom right */}
      <MapControls onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} />
    </div>
  );
}

export default App;
