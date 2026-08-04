// Minimal global declaration for the Google Maps JS API loaded via <script> in
// index.html. The Street View panel uses a small, well-known surface, so we
// declare exactly that rather than pulling in the heavy @types/google.maps
// package — but it is declared properly, not as `any`, so misuse still fails
// typechecking.

interface GoogleLatLngLiteral {
  lat: number;
  lng: number;
}

interface GoogleStreetViewPov {
  heading: number;
  pitch: number;
}

/** The subset of StreetViewPanoramaData the panel reads. */
interface GoogleStreetViewPanoramaData {
  location?: {
    pano?: string;
  };
}

interface GoogleStreetViewPanoramaOptions {
  addressControl?: boolean;
  fullscreenControl?: boolean;
  motionTracking?: boolean;
  motionTrackingControl?: boolean;
  zoomControl?: boolean;
  panControl?: boolean;
  linksControl?: boolean;
  enableCloseButton?: boolean;
}

declare class GoogleStreetViewPanorama {
  constructor(container: HTMLElement, options?: GoogleStreetViewPanoramaOptions);
  setPano(pano: string): void;
  setPov(pov: GoogleStreetViewPov): void;
  setVisible(visible: boolean): void;
}

declare class GoogleStreetViewService {
  getPanorama(
    request: { location: GoogleLatLngLiteral; radius?: number },
    callback: (data: GoogleStreetViewPanoramaData | null, status: string) => void,
  ): void;
}

/** Classes returned by `importLibrary("streetView")`. */
interface GoogleStreetViewLibrary {
  StreetViewService: typeof GoogleStreetViewService;
  StreetViewPanorama: typeof GoogleStreetViewPanorama;
}

interface GoogleMapsNamespace {
  maps: {
    /**
     * The API's readiness contract. With `loading=async` the bootstrap script
     * synchronously creates `google.maps` as a near-empty object and fetches the
     * real classes afterwards, so testing `window.google.maps` for truthiness
     * says nothing about whether a constructor exists yet. `importLibrary`
     * resolves only once the requested library is actually attached.
     *
     * Overloaded on the library name so a typo is a compile error rather than a
     * promise that never resolves.
     */
    importLibrary(name: "streetView"): Promise<GoogleStreetViewLibrary>;
    /**
     * Present only after the corresponding library has loaded — prefer the
     * classes returned by `importLibrary` over reaching for these.
     */
    StreetViewService?: typeof GoogleStreetViewService;
    StreetViewPanorama?: typeof GoogleStreetViewPanorama;
  };
}

declare const google: GoogleMapsNamespace;

interface Window {
  google?: GoogleMapsNamespace;
}
