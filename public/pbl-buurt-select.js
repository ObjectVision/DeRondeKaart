/*
 * Boot PBL's viewer and drive its own selection flow to the neighbourhood in
 * our query string: ?bu=<BU_CODE>. Their page exposes no API for this, so we
 * operate its UI the way a user would. Every step is a guess about markup we do
 * not control, and every step fails soft: if anything is missing the page is
 * left on its own gemeente picker, which still works by hand.
 *
 * The gemeente is derived from the buurt code rather than passed in. A CBS
 * code is "BU" + a 4-digit gemeente + a 4-character buurt, so BU19040213 is
 * gemeente 1904 (Stichtse Vecht). Only the gemeente half is numeric — the buurt
 * half is alphanumeric (BU0363FF03 in Amsterdam), and PBL's own data treats it
 * as an opaque string. That avoids depending on a gemeente name
 * from our own tiles, and avoids matching names at all: PBL's gemeente
 * table is Latin-1 and contains both commas and non-ASCII
 * ("Sudwest-Fryslan"), so name comparison is a needless failure mode.
 *
 * External rather than inline so `script-src 'self'` covers it without needing
 * 'unsafe-inline' or a per-edit sha256 hash in the server CSP. Loaded last, so
 * every PBL script it calls into is already defined.
 */
(function () {
  // PBL's own entry point. Called here rather than from an inline <script> for
  // the same CSP reason; it must run before anything below touches the page.
  kaartenbak_init();

  var params = new URLSearchParams(window.location.search);
  var buurt = params.get("bu");
  if (!buurt || /^BU\d{4}[0-9A-Z]{4}$/.test(buurt) === false) return;
  var gemeenteCode = "GM" + buurt.slice(2, 6);

  var GIVE_UP_MS = 60000;
  var POLL_MS = 150;

  /** Resolve once `test()` is truthy, or reject after GIVE_UP_MS. */
  function waitFor(test, what) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + GIVE_UP_MS;
      (function poll() {
        var value;
        try {
          value = test();
        } catch (err) {
          // A global the page has not defined yet reads as "not ready".
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() > deadline) return reject(new Error("timeout waiting for " + what));
        window.setTimeout(poll, POLL_MS);
      })();
    });
  }

  // The gemeente dropdown is filled from a CSV, so it starts empty.
  waitFor(function () {
    var select = document.getElementById("dd_gemeente");
    return select && select.options.length > 1 ? select : null;
  }, "dd_gemeente")
    .then(function (select) {
      // laadtgemeente() resolves the code from the dropdown's VALUE, which
      // is the gemeente name, so the code has to be turned back into the
      // exact option text. Reading it off the loaded <option>s uses the
      // page's own parse of its CSV — no second fetch, no encoding guess.
      return d3.csv("assets/data/csv/gemeenten_2024.csv").then(function (rows) {
        var row = rows.filter(function (r) { return r.gm_code === gemeenteCode; })[0];
        if (!row) throw new Error("unknown gemeente " + gemeenteCode);
        return { select: select, naam: row.gm_naam };
      });
    })
    .then(function (found) {
      var select = found.select;
      select.value = found.naam;
      if (select.value !== found.naam) {
        throw new Error('gemeente "' + found.naam + '" not in the list');
      }
      select.dispatchEvent(new Event("change"));

      // START is an SVG <rect>, not a button, and setting the dropdown
      // alone does nothing — the page gates loading behind this click.
      var start = document.getElementById("startknop_rect");
      if (!start) throw new Error("no start button");
      var box = start.getBoundingClientRect();
      ["mousedown", "mouseup", "click"].forEach(function (type) {
        start.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            view: window,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
          }),
        );
      });

      // The gemeente's neighbourhood polygons are a ~10MB GeoJSON, and
      // markeerBuurt reads them synchronously — calling it early throws.
      return waitFor(function () {
        return window.dataset_buurtenpolygons && window.dataset_buurtenpolygons.features;
      }, "dataset_buurtenpolygons");
    })
    .then(function () {
      if (typeof window.markeerBuurt !== "function") {
        throw new Error("no markeerBuurt");
      }
      window.markeerBuurt(buurt);
    })
    .catch(function (err) {
      // Deliberately non-fatal: the viewer is fully usable by hand, so a
      // failed auto-select should degrade to that rather than blank out.
      console.warn("PBL auto-select failed:", err && err.message);
    });
})();
