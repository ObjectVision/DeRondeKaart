import type { Accessor } from "solid-js";
import type { MapLayerMouseEvent, MapViewHandle } from "@/components/map/map-view-config";
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
  mapLeft: Accessor<MapViewHandle | null>;
  mapRight: Accessor<MapViewHandle | null>;
  leftEntries: Accessor<LayerEntry[]>;
  rightEntries: Accessor<LayerEntry[]>;
  pickA: UseFeaturePickResult;
  pickB: UseFeaturePickResult;
  hoverA: UseHoverCursorResult;
  hoverB: UseHoverCursorResult;
  boxSelect: BoxSelectState;
  annotationTool: AnnotationToolState;
  /** Annotation mode is on — draw gestures take precedence over picking. */
  annotationActive: Accessor<boolean>;
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
export function useMapPointer(options: UseMapPointerOptions): UseMapPointerResult {
  function onClickA(e: MapLayerMouseEvent) {
    // While a draw tool is armed, clicks belong to its gesture (MapLibre
    // fires click after mouseup) — don't drop the marker or open FeatureInfo.
    if (options.boxSelect.active() || options.annotationActive()) return;
    options.pickA.handleClick(e);
    options.pickB.clear(); // one popup: the latest click wins
    options.setPopupPoint({ x: e.point.x, y: e.point.y });
    options.handleMapClick(e, resolveMarkerPoint(e, options.mapLeft, options.leftEntries()));
  }

  function onClickB(e: MapLayerMouseEvent) {
    if (options.boxSelect.active() || options.annotationActive()) return;
    options.pickB.handleClick(e);
    options.pickA.clear();
    options.setPopupPoint({ x: e.point.x, y: e.point.y });
    options.handleMapClick(e, resolveMarkerPoint(e, options.mapRight, options.rightEntries()));
  }

  function onMouseMoveA(e: MapLayerMouseEvent) {
    options.hoverA.handleMouseMove(e);
    options.boxSelect.handleMouseMove(e);
    options.annotationTool.handleMouseMove(e);
    // Broadcast the live cursor to collab peers (no-op outside a room).
    options.setCursor({ lng: e.lngLat.lng, lat: e.lngLat.lat });
  }

  function onMouseMoveB(e: MapLayerMouseEvent) {
    options.hoverB.handleMouseMove(e);
    options.boxSelect.handleMouseMove(e);
    options.annotationTool.handleMouseMove(e);
    options.setCursor({ lng: e.lngLat.lng, lat: e.lngLat.lat });
  }

  // Mouse down/up dispatch to whichever draw tool is armed (they're mutually
  // exclusive; see the toggles below). The annotation gesture needs to know
  // which map it started on — picks must hit that side's overlay.
  function onMouseDownA(e: MapLayerMouseEvent) {
    if (options.annotationActive()) options.annotationTool.handleMouseDown(e, "a");
    else options.boxSelect.handleMouseDown(e);
  }

  function onMouseDownB(e: MapLayerMouseEvent) {
    if (options.annotationActive()) options.annotationTool.handleMouseDown(e, "b");
    else options.boxSelect.handleMouseDown(e);
  }

  function onMouseUp(e: MapLayerMouseEvent) {
    if (options.annotationActive()) options.annotationTool.handleMouseUp(e);
    else options.boxSelect.handleMouseUp(e);
  }

  // The two draw tools both claim mousedown + the crosshair — arming one
  // disarms the other.
  function toggleAnnotationTool() {
    if (!options.annotationActive() && options.boxSelect.active()) options.boxSelect.toggle();
    options.annotationToggle();
  }

  function toggleAreaSelect() {
    if (!options.boxSelect.active() && options.annotationActive()) options.annotationToggle();
    options.boxSelect.toggle();
  }

  return {
    a: { onClick: onClickA, onMouseMove: onMouseMoveA, onMouseDown: onMouseDownA },
    b: { onClick: onClickB, onMouseMove: onMouseMoveB, onMouseDown: onMouseDownB },
    onMouseUp,
    toggleAnnotationTool,
    toggleAreaSelect,
  };
}
