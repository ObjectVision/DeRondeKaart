import { useEffect, useRef, useState } from "react";

interface StreetViewProps {
  lng: number;
  lat: number;
  onClose?: () => void;
  /** Render bare content (no card chrome/header) inside a parent window. */
  embedded?: boolean;
}

const GOOGLE_MAPS_SRC =
  "https://maps.googleapis.com/maps/api/js?key=AIzaSyA6sQWT0NPNI2JyT4ygpoR93my_WSji6-Q&loading=async";

let googleMapsPromise: Promise<void> | null = null;

/**
 * Load the Google Maps JS API on first use. Street View is the only consumer,
 * so the script (and its third-party fetch) stays off the critical path until
 * a Street View panel actually opens. Idempotent — one script tag ever.
 */
function loadGoogleMapsScript(): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (!googleMapsPromise) {
    googleMapsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GOOGLE_MAPS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        googleMapsPromise = null; // allow a retry on the next open
        reject(new Error("Failed to load Google Maps JS API"));
      };
      document.head.appendChild(script);
    });
  }
  return googleMapsPromise;
}

/** Wait for the lazily loaded Google Maps JS API to be ready. */
async function waitForGoogleMaps(signal: { cancelled: boolean }): Promise<boolean> {
  try {
    await loadGoogleMapsScript();
  } catch {
    return false;
  }
  // `loading=async` — the API may finish initializing just after script load.
  return new Promise((resolve) => {
    const check = () => {
      if (signal.cancelled) return resolve(false);
      if (window.google?.maps) return resolve(true);
      setTimeout(check, 100);
    };
    check();
  });
}

export function StreetView({ lng, lat, onClose, embedded = false }: StreetViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<any>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "unavailable">(
    "loading",
  );

  useEffect(() => {
    const signal = { cancelled: false };

    async function load() {
      const ready = await waitForGoogleMaps(signal);
      if (signal.cancelled) return;
      if (!ready) {
        // Script failed to load (offline, blocked) — show a real state
        // instead of an endless spinner.
        setStatus("unavailable");
        return;
      }
      if (!containerRef.current) return;

      const location = { lat, lng };
      const service = new google.maps.StreetViewService();

      service.getPanorama(
        { location, radius: 50 },
        (data: any, svStatus: string) => {
          if (signal.cancelled) return;

          if (svStatus !== "OK" || !data?.location?.pano) {
            setStatus("unavailable");
            return;
          }

          setStatus("ok");

          if (!panoramaRef.current) {
            panoramaRef.current = new google.maps.StreetViewPanorama(
              containerRef.current,
              {
                addressControl: false,
                fullscreenControl: false,
                motionTracking: false,
                motionTrackingControl: false,
                zoomControl: false,
                panControl: false,
                linksControl: false,
                enableCloseButton: false,
              },
            );
          }

          panoramaRef.current.setPano(data.location.pano);
          panoramaRef.current.setPov({ heading: 0, pitch: 0 });
          panoramaRef.current.setVisible(true);
        },
      );
    }

    setStatus("loading");
    load();

    return () => {
      signal.cancelled = true;
    };
  }, [lng, lat]);

  return (
    <div
      className={
        embedded
          ? "flex flex-col"
          : "flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm"
      }
    >
      {/* Header — omitted when embedded; the parent window owns the close button */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Street View
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      )}

      {/* Body */}
      <div
        className={`relative h-40 overflow-hidden rounded-b-lg ${embedded ? "w-full" : "w-72"}`}
      >
        <div ref={containerRef} className="absolute inset-0" />
        {status !== "ok" && (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-gray-400">
            {status === "loading"
              ? "Street View laden…"
              : "Geen Street View beschikbaar op deze locatie"}
          </div>
        )}
      </div>
    </div>
  );
}
