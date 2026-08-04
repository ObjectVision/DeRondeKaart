import { useEffect, useEffectEvent, useRef } from "react";
import type { MapViewHandle } from "@/components/map/MapView";
import { captureMapCanvas, compositeComparison } from "@/lib/map-capture";

interface UseMapSnapshotOptions {
  mapLeftRef: React.RefObject<MapViewHandle | null>;
  mapRightRef: React.RefObject<MapViewHandle | null>;
  /** Comparison is active — composite left+right at the slider split. */
  comparisonMode: boolean;
  sliderPosition: number;
  /** The left map is ready (same gate as the map-ready handshake). */
  ready: boolean;
}

/**
 * Snapshot bridge for the Power BI custom visual. The visual embeds this app
 * in a cross-origin sandboxed iframe, whose pixels Power BI's PDF/PowerPoint
 * export does NOT rasterize — the map would export blank. So while embedded,
 * the app pushes a JPEG snapshot of the composited map canvas to the parent
 * (`{ type: "map-snapshot", v: 1, dataUrl, width, height }`); the visual
 * paints it into an <img> in its own DOM, which the export path does capture.
 *
 * Snapshots are sent (1) once when the map becomes ready, (2) debounced on
 * the left map's `idle` event (pan/zoom/layer changes settle), and (3) on a
 * `{ type: "request-snapshot" }` message from the visual. Gated on being
 * embedded, NOT on the `share` config flag — PDF export must work even when
 * the share UI is disabled.
 */
export function useMapSnapshot({
  mapLeftRef,
  mapRightRef,
  comparisonMode,
  sliderPosition,
  ready,
}: UseMapSnapshotOptions) {
  const busyRef = useRef(false);

  // An effect event: reads `comparisonMode`/`sliderPosition` at CAPTURE time
  // (not at listener-wiring time) without a ref mirror, so the map listeners
  // below stay wired across slider moves.
  const sendSnapshot = useEffectEvent(async () => {
    if (busyRef.current) return;
    const leftMap = mapLeftRef.current?.mapRef.current?.getMap();
    if (!leftMap) return;
    busyRef.current = true;
    try {
      let canvas = await captureMapCanvas(leftMap);
      const rightMap = mapRightRef.current?.mapRef.current?.getMap();
      if (comparisonMode && rightMap) {
        const right = await captureMapCanvas(rightMap);
        canvas = compositeComparison(canvas, right, sliderPosition);
      }

      // Downscale to CSS-pixel size and JPEG-encode (the map is opaque) to
      // keep the postMessage payload small (~100-300 kB, not multi-MB PNG).
      const container = leftMap.getContainer();
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      const scaled = document.createElement("canvas");
      scaled.width = w;
      scaled.height = h;
      const ctx = scaled.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(canvas, 0, 0, w, h);
      const dataUrl = scaled.toDataURL("image/jpeg", 0.85);

      window.parent.postMessage(
        { type: "map-snapshot", v: 1, dataUrl, width: w, height: h },
        "*",
      );
    } catch (err) {
      console.warn("map-snapshot capture failed:", err);
    } finally {
      busyRef.current = false;
    }
  });

  useEffect(() => {
    const embedded = window.parent && window.parent !== window;
    if (!embedded || !ready) return;

    const map = mapLeftRef.current?.mapRef.current?.getMap();
    if (!map) return;

    // Initial snapshot + debounced refresh whenever the map settles.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSnapshot = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void sendSnapshot(), 500);
    };
    scheduleSnapshot();
    map.on("idle", scheduleSnapshot);

    function handleMessage(event: MessageEvent) {
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "request-snapshot") void sendSnapshot();
    }
    window.addEventListener("message", handleMessage);

    return () => {
      if (timer) clearTimeout(timer);
      map.off("idle", scheduleSnapshot);
      window.removeEventListener("message", handleMessage);
    };
  }, [ready, mapLeftRef]);
}
