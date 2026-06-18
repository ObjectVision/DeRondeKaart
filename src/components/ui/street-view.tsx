import { useEffect, useRef, useState } from "react";

interface StreetViewProps {
  lng: number;
  lat: number;
  onClose: () => void;
}

/** Wait for the async-loaded Google Maps JS API to be ready. */
function waitForGoogleMaps(signal: { cancelled: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (signal.cancelled) return resolve(false);
      if (window.google?.maps) return resolve(true);
      setTimeout(check, 100);
    };
    check();
  });
}

export function StreetView({ lng, lat, onClose }: StreetViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const panoramaRef = useRef<any>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "unavailable">(
    "loading",
  );

  useEffect(() => {
    const signal = { cancelled: false };

    async function load() {
      const ready = await waitForGoogleMaps(signal);
      if (!ready || signal.cancelled || !containerRef.current) return;

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
    <div className="flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm">
      {/* Header */}
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

      {/* Body */}
      <div className="relative w-72 h-40 overflow-hidden rounded-b-lg">
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
