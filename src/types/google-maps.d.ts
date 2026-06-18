// Minimal global declaration for the Google Maps JS API loaded via <script> in
// index.html. The Street View panel uses a small, well-known surface, so we keep
// the typing loose rather than pulling in the heavy @types/google.maps package.
declare const google: any;

interface Window {
  google?: typeof google;
}
