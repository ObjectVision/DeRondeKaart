import { useCallback, useState } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { LayerEntry } from "@/hooks/use-map-layers";
import type { FeatureInfoResult, UseFeaturePickResult } from "@/hooks/use-feature-pick";

/** A geographic point, as the click handlers and marker overlays pass it around. */
export interface LngLat {
  lng: number;
  lat: number;
}

export interface UseClickPopupOptions {
  /** map.json `streetview`, host-overridable. When false no Street View is opened. */
  streetviewEnabled: boolean;
  pickA: UseFeaturePickResult;
  pickB: UseFeaturePickResult;
  leftEntries: LayerEntry[];
  rightEntries: LayerEntry[];
}

export interface UseClickPopupResult {
  /** Latest click position, in map-local px — anchors the popup. */
  popupPoint: { x: number; y: number } | null;
  setPopupPoint: (point: { x: number; y: number } | null) => void;
  /** Where the marker sits, before the config's enabled flag is applied. */
  clickMarker: LngLat | null;
  /** Street View target, or null when closed / disabled. */
  streetView: LngLat | null;
  /** Drops the marker (and Street View) at a click. */
  handleMapClick: (e: MapLayerMouseEvent, snapped: LngLat | null) => void;
  /** Whichever map was clicked last; null when nothing is picked. */
  pickResult: FeatureInfoResult | null;
  /** The entries that `pickResult` came from, for label lookup. */
  pickEntries: LayerEntry[];
  /** Closes the whole popup: both picks, Street View and the anchor. */
  closePopup: () => void;
}

/**
 * The one shared click popup: the clicked point, the marker dropped there, the
 * Street View target, and the resolution of *which* map's pick is being shown.
 *
 * These are one concern even though App used to declare them 500 lines apart. All
 * three pieces of state are shared across both maps rather than per-side — a
 * click on either map replaces the popup, and its single close button has to
 * clear both maps' picks at once, which is why `closePopup` lives with the state
 * it clears rather than next to either pick hook.
 *
 * `setPopupPoint` is exposed because the pointer handlers set the anchor on every
 * click (they own the click routing; this hook owns what the click produced).
 * The per-map marker *overlays* stay in App: they are gated on the right map's
 * mount to keep their GL resources from outliving it.
 */
export function useClickPopup({
  streetviewEnabled,
  pickA,
  pickB,
  leftEntries,
  rightEntries,
}: UseClickPopupOptions): UseClickPopupResult {
  // Shared Street View panel — reflects the most recent click on either map.
  const [streetView, setStreetView] = useState<LngLat | null>(null);
  // Shared click marker — a single dot dropped at the most recent click on either map.
  const [clickMarker, setClickMarker] = useState<LngLat | null>(null);
  // Screen position of the most recent click — anchors the Details/Street View
  // popup just below the pointer. Both maps fill the app root, so the map-local
  // point doubles as a root-relative position.
  const [popupPoint, setPopupPoint] = useState<{ x: number; y: number } | null>(null);

  // Drop the marker (and optional Street View) at a click. When the click hit a
  // point feature, `snapped` carries that feature's location so the marker lands
  // exactly on the point; otherwise we use the raw cursor lngLat.
  const handleMapClick = useCallback(
    (e: MapLayerMouseEvent, snapped: LngLat | null) => {
      const point = snapped ?? { lng: e.lngLat.lng, lat: e.lngLat.lat };
      setClickMarker(point);
      if (!streetviewEnabled) return;
      setStreetView(point);
    },
    [streetviewEnabled],
  );

  // One shared popup: the latest click's pick result (the other map's pick is
  // cleared on click) plus Street View, closed together by its single button.
  const pickResult = pickA.result ?? pickB.result;
  const pickEntries = pickA.result ? leftEntries : rightEntries;

  const pickAClear = pickA.clear;
  const pickBClear = pickB.clear;
  const closePopup = useCallback(() => {
    pickAClear();
    pickBClear();
    setStreetView(null);
    setPopupPoint(null);
  }, [pickAClear, pickBClear]);

  return {
    popupPoint,
    setPopupPoint,
    clickMarker,
    streetView,
    handleMapClick,
    pickResult,
    pickEntries,
    closePopup,
  };
}
