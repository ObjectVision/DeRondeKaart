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

interface GoogleMapsNamespace {
  maps: {
    StreetViewService: typeof GoogleStreetViewService;
    StreetViewPanorama: typeof GoogleStreetViewPanorama;
  };
}

declare const google: GoogleMapsNamespace;

interface Window {
  google?: GoogleMapsNamespace;
}
