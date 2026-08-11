import { useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { MapViewHandle } from "@/components/map/MapView";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { UseFeaturePickResult } from "@/hooks/use-feature-pick";
import type { UseHoverCursorResult } from "@/hooks/use-hover-cursor";
import type { BoxSelectState } from "@/hooks/use-box-select";
import type { AnnotationToolState } from "@/hooks/use-annotation-tool";
import type { LngLat } from "@/hooks/use-click-popup";
import { resolveMarkerPoint } from "@/lib/marker-snap";

/** The pointer callbacks one MapView needs. */
export interface MapPointerSide {
  onClick: (e: MapLayerMouseEvent) => void;
  onMouseMove: (e: MapLayerMouseEvent) => void;
  onMouseDown: (e: MapLayerMouseEvent) => void;
}

export interface UseMapPointerOptions {
  mapLeftRef: React.RefObject<MapViewHandle | null>;
  mapRightRef: React.RefObject<MapViewHandle | null>;
  leftEntries: LayerEntry[];
  rightEntries: LayerEntry[];
  pickA: UseFeaturePickResult;
  pickB: UseFeaturePickResult;
  hoverA: UseHoverCursorResult;
  hoverB: UseHoverCursorResult;
  boxSelect: BoxSelectState;
  annotationTool: AnnotationToolState;
  /** Annotation mode is on — draw gestures take precedence over picking. */
  annotationActive: boolean;
  annotationToggle: () => void;
  /** Broadcasts the live cursor to collab peers; a no-op outside a room. */
  setCursor: (point: LngLat) => void;
  /** From useClickPopup: records the click anchor and drops the marker. */
  setPopupPoint: (point: { x: number; y: number } | null) => void;
  handleMapClick: (e: MapLayerMouseEvent, snapped: LngLat | null) => void;
}

export interface UseMapPointerResult {
  a: MapPointerSide;
  b: MapPointerSide;
  /** Shared by both maps — a gesture ends wherever the mouse is released. */
  onMouseUp: (e: MapLayerMouseEvent) => void;
  /** Enters/leaves annotation mode, disarming the area-select tool. */
  toggleAnnotationTool: () => void;
  /** Arms/disarms area-select, leaving annotation mode. */
  toggleAreaSelect: () => void;
}

/**
 * The pointer fan-out: one click, move or drag on either map dispatched across
 * feature picking, hover cursors, the area-select box, annotation drawing, the
 * click marker and collab presence.
 *
 * This is the piece `useAnnotationCommands` describes App as keeping — and it is
 * here rather than in a per-map hook for a reason that is structural, not
 * stylistic: a click on one map must **clear the other map's pick** (one popup,
 * latest click wins), so a per-side hook would need its sibling's `clear`,
 * which is circular. Taking both sides at once removes that knot; the two mouse-
 * down handlers differ only in the side literal they hand the annotation gesture,
 * and mouse-up is genuinely shared.
 *
 * The `toggle*` pair belongs here because the two draw tools both claim mousedown
 * and the crosshair, so arming one has to disarm the other — the same mutual
 * exclusion the handlers below depend on.
 */
export function useMapPointer({
  mapLeftRef,
  mapRightRef,
  leftEntries,
  rightEntries,
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
}: UseMapPointerOptions): UseMapPointerResult {
  const { active: boxSelectActive, toggle: boxSelectToggle } = boxSelect;

  // Pull the callbacks out so the memo deps are the stable function identities
  // rather than the hook result objects, which change on every state change.
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
      handleMapClick(e, resolveMarkerPoint(e, mapLeftRef, leftEntries));
    },
    [
      boxSelectActive,
      annotationActive,
      pickAClick,
      pickBClear,
      handleMapClick,
      setPopupPoint,
      mapLeftRef,
      leftEntries,
    ],
  );

  const onClickB = useCallback(
    (e: MapLayerMouseEvent) => {
      if (boxSelectActive || annotationActive) return;
      pickBClick(e);
      pickAClear();
      setPopupPoint({ x: e.point.x, y: e.point.y });
      handleMapClick(e, resolveMarkerPoint(e, mapRightRef, rightEntries));
    },
    [
      boxSelectActive,
      annotationActive,
      pickBClick,
      pickAClear,
      handleMapClick,
      setPopupPoint,
      mapRightRef,
      rightEntries,
    ],
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
  // exclusive; see the toggles below). The annotation gesture needs to know
  // which map it started on — picks must hit that side's overlay.
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

  const onMouseUp = useCallback(
    (e: MapLayerMouseEvent) => {
      if (annotationActive) annotationUp(e);
      else boxSelectUp(e);
    },
    [annotationActive, annotationUp, boxSelectUp],
  );

  // The two draw tools both claim mousedown + the crosshair — arming one
  // disarms the other.
  const toggleAnnotationTool = useCallback(() => {
    if (!annotationActive && boxSelectActive) boxSelectToggle();
    annotationToggle();
  }, [annotationActive, boxSelectActive, boxSelectToggle, annotationToggle]);

  const toggleAreaSelect = useCallback(() => {
    if (!boxSelectActive && annotationActive) annotationToggle();
    boxSelectToggle();
  }, [boxSelectActive, annotationActive, annotationToggle, boxSelectToggle]);

  return {
    a: { onClick: onClickA, onMouseMove: onMouseMoveA, onMouseDown: onMouseDownA },
    b: { onClick: onClickB, onMouseMove: onMouseMoveB, onMouseDown: onMouseDownB },
    onMouseUp,
    toggleAnnotationTool,
    toggleAreaSelect,
  };
}
