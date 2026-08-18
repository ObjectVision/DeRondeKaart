import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";

interface StreetViewProps {
  lng: number;
  lat: number;
  onClose?: () => void;
  /** Render bare content (no card chrome/header) inside a parent window. */
  embedded?: boolean;
}

/**
 * Global the Maps bootstrap calls once the API is genuinely ready.
 *
 * With `loading=async` the script's own `load` event fires when the ~13 kB
 * bootstrap has parsed — NOT when the API is usable. At that moment
 * `google.maps` is `{ modules, __gjsload__, Load }`: no `StreetViewService`,
 * and no `importLibrary` either. The bootstrap then fetches `main.js`, and only
 * afterwards invokes `callback`. Google's docs are explicit that with
 * `loading=async` "no JavaScript code is triggered by the script's load event"
 * and the `callback` parameter is the supported readiness signal.
 */
const CALLBACK_NAME = "__northwakeGoogleMapsReady";

// `libraries=streetView` makes the bootstrap fetch the Street View module as
// part of the same pass, so it is attached by the time `callback` fires.
const GOOGLE_MAPS_SRC =
  "https://maps.googleapis.com/maps/api/js?key=AIzaSyA6sQWT0NPNI2JyT4ygpoR93my_WSji6-Q" +
  `&loading=async&libraries=streetView&callback=${CALLBACK_NAME}`;

let googleMapsPromise: Promise<void> | null = null;
let streetViewLibrary: GoogleStreetViewLibrary | null = null;

/**
 * Load the Google Maps JS API on first use. Street View is the only consumer,
 * so the script (and its third-party fetch) stays off the critical path until
 * a Street View panel actually opens. Idempotent — one script tag ever.
 */
function loadGoogleMapsScript(): Promise<void> {
  if (!googleMapsPromise) {
    googleMapsPromise = new Promise((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      // Resolve from the API's callback, NOT script.onload — see CALLBACK_NAME.
      w[CALLBACK_NAME] = () => {
        delete w[CALLBACK_NAME];
        resolve();
      };
      const script = document.createElement("script");
      script.src = GOOGLE_MAPS_SRC;
      script.async = true;
      script.onerror = () => {
        delete w[CALLBACK_NAME];
        googleMapsPromise = null; // allow a retry on the next open
        script.remove();
        reject(new Error("Failed to load Google Maps JS API"));
      };
      document.head.appendChild(script);
    });
  }
  return googleMapsPromise;
}

/**
 * Load the API and resolve the Street View classes, or null if unavailable.
 *
 * Returns the constructors rather than a boolean so callers cannot reach for
 * `google.maps.StreetViewService` before it exists. That was the bug this
 * replaces: the old code waited for `window.google.maps` to be truthy, but the
 * bootstrap sets `google.maps = google.maps || {}` on its very first line, so
 * the check passed the instant the script parsed and
 * `new google.maps.StreetViewService()` threw "is not a constructor" whenever
 * the module fetch hadn't landed yet (cold cache / slow network).
 */
async function loadStreetViewLibrary(): Promise<GoogleStreetViewLibrary | null> {
  if (streetViewLibrary) return streetViewLibrary;
  try {
    await loadGoogleMapsScript();
    // Safe here: the callback has fired, so main.js is in and importLibrary
    // exists. It is idempotent, and the result is cached above so reopening the
    // panel doesn't re-await.
    streetViewLibrary = await google.maps.importLibrary("streetView");
    return streetViewLibrary;
  } catch {
    return null;
  }
}

export function StreetView(props: StreetViewProps): JSX.Element {
  let container!: HTMLDivElement;
  let panorama: GoogleStreetViewPanorama | null = null;
  const [status, setStatus] = createSignal<"loading" | "ok" | "unavailable">("loading");

  createEffect(() => {
    const lng = props.lng;
    const lat = props.lat;
    const signal = { cancelled: false };

    async function load() {
      const library = await loadStreetViewLibrary();
      if (signal.cancelled) return;
      if (!library) {
        // Script failed to load (offline, blocked) — show a real state
        // instead of an endless spinner.
        setStatus("unavailable");
        return;
      }

      const location = { lat, lng };
      const service = new library.StreetViewService();

      service.getPanorama(
        { location, radius: 50 },
        (data: GoogleStreetViewPanoramaData | null, svStatus: string) => {
          if (signal.cancelled) return;

          if (svStatus !== "OK" || !data?.location?.pano) {
            setStatus("unavailable");
            return;
          }

          setStatus("ok");

          if (!panorama) {
            panorama = new library.StreetViewPanorama(container, {
              addressControl: false,
              fullscreenControl: false,
              motionTracking: false,
              motionTrackingControl: false,
              zoomControl: false,
              panControl: false,
              linksControl: false,
              enableCloseButton: false,
            });
          }

          panorama.setPano(data.location.pano);
          panorama.setPov({ heading: 0, pitch: 0 });
          panorama.setVisible(true);
        },
      );
    }

    // Reset to the spinner before each (re)load: the status is driven by the
    // async Google Maps panorama lookup in `load()` and cannot be derived.
    setStatus("loading");
    load();

    onCleanup(() => {
      signal.cancelled = true;
    });
  });

  return (
    <div
      class={
        props.embedded
          ? "flex flex-col"
          : "flex flex-col rounded-lg bg-white/90 shadow-md backdrop-blur-sm"
      }
    >
      {/* Header — omitted when embedded; the parent window owns the close button */}
      <Show when={!props.embedded}>
        <div class="flex items-center justify-between px-3 pt-2 pb-1">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Street View
          </h3>
          <button
            onClick={() => props.onClose?.()}
            class="text-gray-400 hover:text-gray-600 transition-colors text-sm leading-none px-1"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      </Show>

      {/* Body */}
      <div class={`relative h-40 overflow-hidden rounded-b-lg ${props.embedded ? "w-full" : "w-72"}`}>
        <div ref={container} class="absolute inset-0" />
        <Show when={status() !== "ok"}>
          <div class="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-gray-400">
            {status() === "loading"
              ? "Street View laden…"
              : "Geen Street View beschikbaar op deze locatie"}
          </div>
        </Show>
      </div>
    </div>
  );
}
