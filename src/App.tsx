import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ViewStateChangeEvent, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MapView, BASEMAPS, DEFAULT_BASEMAP_ID } from "@/components/map/MapView";
import type { MapViewHandle, ViewState } from "@/components/map/MapView";
import { useMapLayers } from "@/hooks/use-map-layers";
import { useStudyAreaLayer } from "@/hooks/use-study-area-layer";
import {
  useFilteredStudyArea,
  useFilteredStudyAreaLayers,
} from "@/hooks/use-filtered-study-area";
import { useClickMarkerLayers } from "@/hooks/use-click-marker-layer";
import { resolveMarkerPoint } from "@/lib/marker-snap";
import { viewForBbox } from "@/lib/fly-to";
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
import { useAnnotations } from "@/hooks/use-annotations";
import { useCollab } from "@/hooks/use-collab";
import { useAnnotationTool, type AnnotationHit } from "@/hooks/use-annotation-tool";
import {
  useAnnotationLayers,
  isAnnotationIconified,
  PIN_SIZE_ACTIVE_PX,
  type PolygonHandleDatum,
} from "@/hooks/use-annotation-layers";
import { centroid, METERS_PER_DEGREE_LAT } from "@/lib/geo";
import { AnnotationEditPopup } from "@/components/annotations/AnnotationEditPopup";
import { PresenceBadge } from "@/components/annotations/PresenceBadge";
import { restoreSnapshot } from "@/lib/annotation-restore";
import { isUrlAddressable } from "@/lib/share-url";
import {
  selectionsToJson,
  type Annotation,
  type AnnotationSnapshot,
} from "@/types/annotation";
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
import { CircularExportView } from "@/components/share/CircularExportView";
import { legendItemsForEntries } from "@/lib/legend-style";
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
  shareEnabled: shareEnabledProp = true,
  filterFlyToEnabled = true,
  annotationsEnabled: annotationsEnabledProp = false,
  mapControls = DEFAULT_MAP_CONTROLS,
  clickMarker: clickMarkerConfig = DEFAULT_CLICK_MARKER,
  embedCircular = false,
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
  filterFlyToEnabled?: boolean;
  annotationsEnabled?: boolean;
  mapControls?: MapControlsConfig;
  clickMarker?: ClickMarkerConfig;
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

  // Gemeente/Wijk/Buurt area filter (sidebar). Selections live in a module
  // store read by the layer accessors; on change, re-clone both maps' deck
  // layers so the accessors re-evaluate. Declared up here because the study
  // area below swaps to the selected gebied's geometry.
  const areaFilter = useAreaFilter({ flyTo: filterFlyToEnabled });

  // Always-on study area, pinned above everything (incl. labels) on both maps.
  // Separate instances — Layer objects must not be shared across two Deck overlays.
  // While a gebiedsfilter selection is active, the configured studyarea is
  // replaced by the selected gebied (finest level): a 200 km mask disc around
  // it plus the gebied outline.
  const studyLayersA = useStudyAreaLayer(studyAreaId);
  const studyLayersB = useStudyAreaLayer(showMapRight ? studyAreaId : undefined);
  const filteredStudy = useFilteredStudyArea(areaFilter);
  const filteredStudyLayersA = useFilteredStudyAreaLayers(filteredStudy, "a");
  const filteredStudyLayersB = useFilteredStudyAreaLayers(
    showMapRight ? filteredStudy : null,
    "b",
  );
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
  // map.json `clickMarker.enabled: false` (or `clickMarker: false`) suppresses
  // the marker; clicks still open popups/Street View.
  const markerPoint = clickMarkerConfig.enabled ? clickMarker : null;
  const markerLayersA = useClickMarkerLayers(markerPoint, clickMarkerConfig);
  const markerLayersB = useClickMarkerLayers(showMapRight ? markerPoint : null, clickMarkerConfig);

  // Area-select tool: a drawn rectangle restricting the charts/statistics to
  // rows inside it (ANDed with the area filter). One shared instance — the box
  // is a single filter shown on both maps; map rendering is unaffected.
  const boxSelect = useBoxSelect();
  const { active: boxSelectActive, toggle: boxSelectToggle } = boxSelect;
  const selectionBox = boxSelect.draft ?? boxSelect.box;
  const boxLayersA = useSelectionBoxLayers(selectionBox, "a");
  const boxLayersB = useSelectionBoxLayers(showMapRight ? selectionBox : null, "b");

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
  const mapLeftLayersRef = useRef(mapLeftLayers);
  mapLeftLayersRef.current = mapLeftLayers;
  const mapRightLayersRef = useRef(mapRightLayers);
  mapRightLayersRef.current = mapRightLayers;
  const annotationListRef = useRef(annotations.annotations);
  annotationListRef.current = annotations.annotations;
  /* eslint-enable react-hooks/refs */
  const restoreTokenRef = useRef(0);

  // Everything an annotation restores: filter selections, both sides'
  // (URL-addressable) layer ids + hidden ids, and the camera.
  const captureSnapshot = useCallback(
    (): AnnotationSnapshot => ({
      areaFilterSelections: selectionsToJson(areaFilter.selections),
      mapA: {
        layerIds: mapLeftLayers.layerEntries
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...mapLeftLayers.hiddenIds],
      },
      mapB: {
        layerIds: mapRightLayers.layerEntries
          .filter(isUrlAddressable)
          .map((e) => e.config.id),
        hiddenIds: [...mapRightLayers.hiddenIds],
      },
      view: {
        longitude: viewState.longitude,
        latitude: viewState.latitude,
        zoom: viewState.zoom,
      },
    }),
    [areaFilter.selections, mapLeftLayers, mapRightLayers, viewState],
  );

  const handleAnnotationCreate = useCallback(
    (center: { lng: number; lat: number }, radiusM: number): string => {
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        center,
        radiusM,
        title: "",
        description: "",
        color: collab.identity.color,
        author: collab.identity.name,
        createdAt: Date.now(),
        snapshot: captureSnapshot(),
      };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, collab.identity, captureSnapshot],
  );

  const handleAnnotationCreatePolygon = useCallback(
    (points: Array<{ lng: number; lat: number }>): string => {
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        center: centroid(points),
        radiusM: 0,
        points,
        title: "",
        description: "",
        color: collab.identity.color,
        author: collab.identity.name,
        createdAt: Date.now(),
        snapshot: captureSnapshot(),
      };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, collab.identity, captureSnapshot],
  );

  const handleAnnotationCreatePin = useCallback(
    (center: { lng: number; lat: number }): string => {
      const annotation: Annotation = {
        id: crypto.randomUUID(),
        center,
        radiusM: 0,
        pin: true,
        title: "",
        description: "",
        color: collab.identity.color,
        author: collab.identity.name,
        createdAt: Date.now(),
        snapshot: captureSnapshot(),
      };
      annotations.add(annotation);
      return annotation.id;
    },
    [annotations, collab.identity, captureSnapshot],
  );

  const handleAnnotationMove = useCallback(
    (id: string, center: { lng: number; lat: number }) => {
      annotations.update(id, { center });
    },
    [annotations],
  );

  const handleAnnotationEditPoints = useCallback(
    (
      id: string,
      points: Array<{ lng: number; lat: number }>,
      center: { lng: number; lat: number },
    ) => {
      annotations.update(id, { points, center });
    },
    [annotations],
  );

  const handleAnnotationResize = useCallback(
    (id: string, radiusM: number) => {
      annotations.update(id, { radiusM });
    },
    [annotations],
  );

  // Plain click on a circle: bring the session back to the annotation's
  // snapshot. Local-only — peers' maps don't move.
  const handleAnnotationRestore = useCallback((id: string) => {
    const annotation = annotationListRef.current.find((a) => a.id === id);
    if (!annotation) return;
    const token = ++restoreTokenRef.current;
    void restoreSnapshot(
      annotation.snapshot,
      {
        applySelections: (next) => areaFilterRef.current.applySelections(next),
        getSideA: () => ({
          layers: mapLeftLayersRef.current,
          mapRef: mapLeftRef.current?.mapRef ?? { current: null },
        }),
        getSideB: () => ({
          layers: mapRightLayersRef.current,
          mapRef: mapRightRef.current?.mapRef ?? { current: null },
        }),
      },
      () => restoreTokenRef.current !== token,
    );
  }, []);

  // Synchronous deck pick against a side's annotation layers, deciding at
  // mousedown what the gesture edits. Handles (vertices, then edges) win over
  // shape bodies, with a wider pick radius so they're easy to grab.
  const pickAnnotationAt = useCallback(
    (side: "a" | "b", point: { x: number; y: number }): AnnotationHit | null => {
      const handle = side === "a" ? mapLeftRef.current : mapRightRef.current;
      const overlay = handle?.overlayRef.current;
      if (!overlay) return null;
      const pick = (layerIds: string[], radius: number) =>
        overlay.pickObject({ x: point.x, y: point.y, radius, layerIds });

      const vertex = pick([`annotations-vertices-${side}`], 6);
      if (vertex?.object) {
        const d = vertex.object as PolygonHandleDatum;
        return { type: "vertex", annotation: d.annotation, index: d.index };
      }
      const edge = pick([`annotations-edges-${side}`], 4);
      if (edge?.object) {
        const d = edge.object as PolygonHandleDatum;
        return { type: "edge", annotation: d.annotation, index: d.index };
      }
      const body = pick(
        [
          `annotations-shape-icons-${side}`,
          `annotations-pins-${side}`,
          `annotations-circles-${side}`,
          `annotations-polygons-${side}`,
        ],
        2,
      );
      if (body?.object) {
        const annotation = body.object as Annotation;
        if (body.layer?.id.startsWith("annotations-shape-icons")) {
          return { type: "icon", annotation };
        }
        return {
          type: annotation.pin ? "pin" : annotation.points ? "polygon" : "circle",
          annotation,
        };
      }
      return null;
    },
    [],
  );

  const annotationTool = useAnnotationTool({
    onCreate: handleAnnotationCreate,
    onCreatePolygon: handleAnnotationCreatePolygon,
    onCreatePin: handleAnnotationCreatePin,
    onMove: handleAnnotationMove,
    onResize: handleAnnotationResize,
    onEditPoints: handleAnnotationEditPoints,
    onRestore: handleAnnotationRestore,
    onDelete: (id) => annotations.remove(id),
    pickAnnotationAt,
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
  // iconScale 4: 96px atlas cells — a clean 2× step down from the SVGs'
  // intrinsic 192px raster, and ≥ the 32-38px draw size on hi-DPI screens,
  // so pins render crisp without a jagged single-step downscale.
  const annotLayersA = useAnnotationLayers({
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: collab.identity.color,
    visible: annotationsVisible,
    zoom: viewState.zoom,
    suffix: "a",
    iconScale: 4,
  });
  const annotLayersB = useAnnotationLayers({
    annotations: annotations.annotations,
    draft: annotationTool.draft,
    selectedId: annotationSelectedId,
    peers: collab.peers,
    identityColor: collab.identity.color,
    visible: annotationsVisible && showMapRight,
    zoom: viewState.zoom,
    suffix: "b",
    iconScale: 4,
  });

  // Stable topLayers arrays — inline `[...a, ...b, ...c]` would feed MapView a
  // new array every render (60×/sec while panning), defeating its layer memo.
  // The configured studyarea layers are CLONED on every evaluation: the stored
  // instances get finalized (GL programs deleted) while a gebied selection
  // replaces them, and handing a finalized instance back to deck draws against
  // dead programs ("getUniformBlockIndex ... not an object" floods). A clone is
  // a fresh unfinalized instance; deck matches it by id, so while the layers
  // stay mounted the clone is a cheap no-op state transfer.
  const topLayersA = useMemo(
    () => [
      ...(filteredStudy ? filteredStudyLayersA : studyLayersA.map((l) => l.clone({}))),
      ...markerLayersA,
      ...boxLayersA,
      ...annotLayersA,
    ],
    [filteredStudy, filteredStudyLayersA, studyLayersA, markerLayersA, boxLayersA, annotLayersA],
  );
  const topLayersB = useMemo(
    () => [
      ...(filteredStudy ? filteredStudyLayersB : studyLayersB.map((l) => l.clone({}))),
      ...markerLayersB,
      ...boxLayersB,
      ...annotLayersB,
    ],
    [filteredStudy, filteredStudyLayersB, studyLayersB, markerLayersB, boxLayersB, annotLayersB],
  );

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

  // Compose feature picking with Street View capture so both run per click
  const pickAClick = pickA.handleClick;
  const pickBClick = pickB.handleClick;
  const pickAClear = pickA.clear;
  const pickBClear = pickB.clear;
  const onClickA = useCallback(
    (e: MapLayerMouseEvent) => {
      // While a draw tool is armed, clicks belong to its gesture (MapLibre
      // fires click after mouseup) — don't drop the marker or open FeatureInfo.
      if (boxSelectActive || annotationActive) return;
      pickAClick(e);
      pickBClear(); // one popup: the latest click wins
      setPopupPoint({ x: e.point.x, y: e.point.y });
      handleMapClick(e, resolveMarkerPoint(e, mapLeftRef, mapLeftLayers.layerEntries));
    },
    [boxSelectActive, annotationActive, pickAClick, pickBClear, handleMapClick, mapLeftLayers.layerEntries],
  );
  const onClickB = useCallback(
    (e: MapLayerMouseEvent) => {
      if (boxSelectActive || annotationActive) return;
      pickBClick(e);
      pickAClear();
      setPopupPoint({ x: e.point.x, y: e.point.y });
      handleMapClick(e, resolveMarkerPoint(e, mapRightRef, mapRightLayers.layerEntries));
    },
    [boxSelectActive, annotationActive, pickBClick, pickAClear, handleMapClick, mapRightLayers.layerEntries],
  );

  const hoverAMove = hoverA.handleMouseMove;
  const hoverBMove = hoverB.handleMouseMove;
  const boxSelectMove = boxSelect.handleMouseMove;
  const annotationMove = annotationTool.handleMouseMove;
  const onMouseMoveA = useCallback(
    (e: MapLayerMouseEvent) => {
      hoverAMove(e);
      boxSelectMove(e);
      annotationMove(e);
      // Broadcast the live cursor to collab peers (no-op outside a room).
      setCursor({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    },
    [hoverAMove, boxSelectMove, annotationMove, setCursor],
  );
  const onMouseMoveB = useCallback(
    (e: MapLayerMouseEvent) => {
      hoverBMove(e);
      boxSelectMove(e);
      annotationMove(e);
      setCursor({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    },
    [hoverBMove, boxSelectMove, annotationMove, setCursor],
  );

  // Mouse down/up dispatch to whichever draw tool is armed (they're mutually
  // exclusive; see the toggle wrappers below). The annotation gesture needs to
  // know which map it started on — picks must hit that side's deck overlay.
  const boxSelectDown = boxSelect.handleMouseDown;
  const boxSelectUp = boxSelect.handleMouseUp;
  const annotationDown = annotationTool.handleMouseDown;
  const annotationUp = annotationTool.handleMouseUp;
  const onMouseDownA = useCallback(
    (e: MapLayerMouseEvent) => {
      if (annotationActive) annotationDown(e, "a");
      else boxSelectDown(e);
    },
    [annotationActive, annotationDown, boxSelectDown],
  );
  const onMouseDownB = useCallback(
    (e: MapLayerMouseEvent) => {
      if (annotationActive) annotationDown(e, "b");
      else boxSelectDown(e);
    },
    [annotationActive, annotationDown, boxSelectDown],
  );
  const onMouseUpAB = useCallback(
    (e: MapLayerMouseEvent) => {
      if (annotationActive) annotationUp(e);
      else boxSelectUp(e);
    },
    [annotationActive, annotationUp, boxSelectUp],
  );

  // The two draw tools both claim mousedown + the crosshair — arming one
  // disarms the other.
  const handleAnnotationToolToggle = useCallback(() => {
    if (!annotationActive && boxSelectActive) boxSelectToggle();
    annotationToggle();
  }, [annotationActive, boxSelectActive, boxSelectToggle, annotationToggle]);
  const handleAreaSelectToggle = useCallback(() => {
    if (!boxSelectActive && annotationActive) annotationToggle();
    boxSelectToggle();
  }, [boxSelectActive, annotationActive, annotationToggle, boxSelectToggle]);

  // Navigation menu: add/remove layers against the shared per-map state
  const nav = useNavigation({ mapLeftLayers, mapRightLayers, mapLeftRef, mapRightRef });

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
  const handleChartsClose = useCallback(() => setChartsMinimized(true), [setChartsMinimized]);
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
  // The bare circular-only view (only the circle + legend + title, no map
  // chrome). Driven by the `open-circular` message; always on in `embedCircular`.
  const [circularOpen, setCircularOpen] = useState(false);
  // Export title/subtitle live here (not inside ShareDialog) so a host
  // `open-circular` message can prefill them — see openCircular below.
  const [shareTitle, setShareTitle] = useState("");
  const [shareSubtitle, setShareSubtitle] = useState("");

  // Sharing while the annotation tool is armed promotes the local session to
  // a collaborative room: mint an unguessable UUID (the room's only access
  // key — see collab-server/README.md) and connect; Yjs sync seeds the local
  // annotations into the fresh room. The id persists for re-shares.
  useEffect(() => {
    if (shareOpen && annotationsEnabled && annotationActive && !collab.roomId) {
      startSession(crypto.randomUUID());
    }
  }, [shareOpen, annotationsEnabled, annotationActive, collab.roomId, startSession]);

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

  // A host `open-circular` message: prefill the export title/subtitle and show
  // the bare circular-only view — only the circle + legend + title, no map
  // chrome. (No-op when sharing is disabled here.) The layers/view/filter are
  // already reconciled by useUrlCommands before this fires.
  const openCircular = useCallback(
    ({ title, subtitle }: { title?: string; subtitle?: string }) => {
      if (!shareEnabled) {
        console.warn("open-circular ignored: sharing is disabled in this configuration");
        return;
      }
      if (title !== undefined) setShareTitle(title);
      if (subtitle !== undefined) setShareSubtitle(subtitle);
      setCircularOpen(true);
    },
    [shareEnabled],
  );

  // A host `filter` message: set the gebiedsfilter by level name → CBS code or
  // display label. Resolves against the loaded filter options and applies
  // coarse→fine through the same setValue path the dropdowns use (cascade
  // pruning + fly-to included). Unknown levels/values are warned and skipped.
  const setFilterFromHost = useCallback((filter: Record<string, string | null>) => {
    const af = areaFilterRef.current;
    if (af.entries.length === 0) {
      console.warn("filter ignored: no gebiedsfilter is configured (filter.json empty)");
      return;
    }
    // Apply coarse→fine (filter.json/entries order) so each level's options are
    // narrowed by the ancestors already selected in this same pass.
    for (const entry of af.entries) {
      const match = Object.keys(filter).find(
        (level) => level.toLowerCase() === entry.name.toLowerCase(),
      );
      if (match === undefined) continue;

      const value = filter[match];
      if (value === null || value === "") {
        af.setValue(entry.key, null);
        continue;
      }

      const options = af.optionsFor(entry);
      const resolved =
        options.find((o) => o.code === value) ??
        options.find((o) => o.label.toLowerCase() === value.toLowerCase());
      if (!resolved) {
        console.warn(
          `filter: value "${value}" not found for level "${entry.name}" (skipped)`,
        );
        continue;
      }
      af.setValue(entry.key, resolved.code);
    }

    for (const level of Object.keys(filter)) {
      if (!af.entries.some((e) => e.name.toLowerCase() === level.toLowerCase())) {
        console.warn(`filter: unknown level "${level}" (skipped)`);
      }
    }
  }, []);

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
    [shareEnabled],
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
        <MapControls
          orientation="horizontal"
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          showSearch={mapControls.search}
          showZoom={mapControls.zoom}
        />
      </>
    ),
    [sectionToggles, shareButton, handleZoomIn, handleZoomOut, mapControls.search, mapControls.zoom],
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
  // message. Keyed on the shown layer set so it re-seeds from the current
  // state each time it opens (the preview snapshots at mount — see
  // ExportPreviewMap).
  const circularView = (
    <CircularExportView
      key={shareSide.layerEntries.map((e) => e.config.id).join(",")}
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
    />
  );

  // Circular-only view: NOTHING but the circle + legend + title, centered on a
  // white page — no map chrome, toolbar, sidebar or backdrop. Rendered both for
  // the standalone `?embed=circular` page and when a host `open-circular`
  // message requests it (the message-driven case gets a close button to return
  // to the full app). This replaces the whole app rather than overlaying it.
  const showCircularOnly = embedCircular || (shareEnabled && circularOpen);
  if (showCircularOnly) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-white p-4">
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
        <div className="w-full max-w-[30rem]">{circularView}</div>
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
          layers={mapLeftLayers.deckLayers}
          topLayers={topLayersA}
          basemapId={basemapId}
          style={{ width: "100%", height: "100%" }}
          viewState={viewState}
          onMove={handleMove}
          onClick={onClickA}
          onMouseMove={onMouseMoveA}
          onMouseDown={onMouseDownA}
          onMouseUp={onMouseUpAB}
          onLoad={() => setMapLeftReady(true)}
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
            layers={mapRightLayers.deckLayers}
            topLayers={topLayersB}
            basemapId={basemapId}
            style={{ width: "100%", height: "100%" }}
            viewState={viewState}
            onMove={handleMove}
            onClick={onClickB}
            onMouseMove={onMouseMoveB}
            onMouseDown={onMouseDownB}
            onMouseUp={onMouseUpAB}
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
        {/* Right-map legend sits to the left of the attribution info button; it
            only appears in comparison mode, where the right map is on screen. */}
        <div className="flex items-end gap-2">
          {comparisonMode && !legendMinimized && (
            <Legend
              entries={mapRightLayers.layerEntries}
              hiddenIds={mapRightLayers.hiddenIds}
              hiddenRules={mapRightLayers.hiddenRules}
              onToggle={handleToggleB}
              onToggleRule={handleToggleRuleB}
              onRemove={handleRemoveB}
              onMove={handleMoveToLeft}
              moveDirection="left"
            />
          )}
          <MapAttribution />
        </div>
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
          toolbar={sidebarToolbar}
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
            <div className="flex flex-shrink-0 items-center gap-1 rounded-xl bg-white/95 p-1 shadow-md backdrop-blur-sm">
              {/* Drawing toolbar — left of the mode toggle, only in the mode.
                  Arming the circle tool places one circle, then disarms. */}
              {annotationActive && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      annotationSetTool(annotationDrawTool === "circle" ? null : "circle")
                    }
                    title="Cirkel plaatsen"
                    aria-label="Cirkel plaatsen"
                    aria-pressed={annotationDrawTool === "circle"}
                  >
                    <Icon
                      name="circle"
                      size={chromeIconSize()}
                      color={annotationDrawTool === "circle" ? chromeIconColor() : undefined}
                      className={annotationDrawTool === "circle" ? undefined : "text-gray-400"}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      annotationSetTool(annotationDrawTool === "polygon" ? null : "polygon")
                    }
                    title="Polygoon plaatsen"
                    aria-label="Polygoon plaatsen"
                    aria-pressed={annotationDrawTool === "polygon"}
                  >
                    <Icon
                      name="pentagon"
                      size={chromeIconSize()}
                      color={annotationDrawTool === "polygon" ? chromeIconColor() : undefined}
                      className={annotationDrawTool === "polygon" ? undefined : "text-gray-400"}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      annotationSetTool(annotationDrawTool === "pin" ? null : "pin")
                    }
                    title="Pin plaatsen"
                    aria-label="Pin plaatsen"
                    aria-pressed={annotationDrawTool === "pin"}
                  >
                    <Icon
                      name="location_on"
                      size={chromeIconSize()}
                      color={annotationDrawTool === "pin" ? chromeIconColor() : undefined}
                      className={annotationDrawTool === "pin" ? undefined : "text-gray-400"}
                    />
                  </Button>
                  <div className="h-4 w-px bg-gray-200" aria-hidden />
                </>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleAnnotationToolToggle}
                title={annotationActive ? "Annotaties sluiten" : "Annotaties"}
                aria-label={annotationActive ? "Annotaties sluiten" : "Annotaties"}
                aria-pressed={annotationActive}
              >
                <Icon
                  name={annotationActive ? "edit_off" : "edit"}
                  size={chromeIconSize()}
                  color={annotationActive ? chromeIconColor() : undefined}
                  className={annotationActive ? undefined : "text-gray-400"}
                />
              </Button>
              {annotationActive && collab.roomId && (
                <PresenceBadge peers={collab.peers} connected={collab.connected} />
              )}
            </div>
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
          annotation={selectedAnnotation}
          x={annotationPopupPos.x}
          y={annotationPopupPos.y}
          onChange={(patch) => annotations.update(selectedAnnotation.id, patch)}
          onRecapture={() =>
            // Re-capture the FULL session snapshot — both maps' layers +
            // hidden ids, gebiedsfilters and camera — exactly like creation.
            annotations.update(selectedAnnotation.id, { snapshot: captureSnapshot() })
          }
          onDelete={() => {
            // Same as the Delete/Backspace shortcut: deselect, then remove.
            annotationSelect(null);
            annotations.remove(selectedAnnotation.id);
          }}
        />
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
            entries={leftLegendUsesMapB ? mapRightLayers.layerEntries : mapLeftLayers.layerEntries}
            hiddenIds={leftLegendUsesMapB ? mapRightLayers.hiddenIds : mapLeftLayers.hiddenIds}
            hiddenRules={leftLegendUsesMapB ? mapRightLayers.hiddenRules : mapLeftLayers.hiddenRules}
            onToggle={leftLegendUsesMapB ? handleToggleB : handleToggleA}
            onToggleRule={leftLegendUsesMapB ? handleToggleRuleB : handleToggleRuleA}
            onRemove={leftLegendUsesMapB ? handleRemoveB : handleRemoveA}
            onMove={leftLegendUsesMapB ? handleMoveToLeft : handleMoveToRight}
            moveDirection={leftLegendUsesMapB ? "left" : "right"}
            // Moving the left map's only layer to the right map would empty the
            // left map (which anchors the comparison) — grey the button out.
            moveDisabled={!leftLegendUsesMapB && mapLeftLayers.layerEntries.length <= 1}
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
