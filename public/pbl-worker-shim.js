/*
 * PBL renders the neighbourhood polygons in a Web Worker
 * (L.vectorGrid.slicer -> js/thirdparty/webworker.js). `new Worker()`
 * rejects a cross-origin script URL, and with <base> pointing at PBL every
 * worker URL is cross-origin. Without this shim the summary text still
 * fills in, but no outlines are drawn and the map never zooms — a failure
 * that looks like a data problem rather than a security one.
 *
 * The worker script is served with `Access-Control-Allow-Origin: *`, so it
 * can be fetched and re-created as a same-origin blob.
 *
 * External rather than inline so `script-src 'self'` covers it without
 * needing 'unsafe-inline' or a per-edit sha256 hash in the server CSP.
 * Must run BEFORE PBL's own scripts, so it is loaded first in the <head>.
 */
(function () {
  var NativeWorker = window.Worker;
  window.Worker = function (url, options) {
    var absolute = new URL(url, document.baseURI).href;
    if (absolute.indexOf(window.location.origin) === 0) {
      return new NativeWorker(absolute, options);
    }
    var request = new XMLHttpRequest();
    // Synchronous on purpose: the Worker constructor has to return an
    // object, so the source cannot be awaited.
    request.open("GET", absolute, false);
    request.send();
    var blob = new Blob([request.responseText], { type: "application/javascript" });
    return new NativeWorker(URL.createObjectURL(blob), options);
  };
})();
