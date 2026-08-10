Performance optimization scan — northwake webmap
Context
The app renders 85 layers (76 geoparquet, 8 COG, 1 MVT; 315 GeoStyler rules total, max 12 rules on a single layer) through a MapboxOverlay (interleaved deck.gl) inside MapLibre, with an optional second map for A/B comparison. Everything — WASM parquet parsing, per-feature style resolution, per-pixel COG coloring — runs on the main thread in a single unmemoized 777-line App.tsx.

This scan found six issues, all verified by reading the code. Two of them are outright algorithmic defects (quadratic work), not tuning opportunities. The goal is to fix them in order of effort so the cheap wins land first.

Note: two premises worth flagging up front. CLAUDE.md describes standalone deck.gl and @developmentseed/deck.gl-geotiff; the code actually uses @deck.gl/mapbox MapboxOverlay and @geomatico/maplibre-cog-protocol. @deck.gl/mapbox is imported but is not a declared dependency (it resolves transitively through the unused deck.gl umbrella package) — a latent build break worth fixing regardless.

1. Cumulative batches × per-batch layer ids = quadratic rendering ⭐ biggest win, small diff
The defect. emitBatches emits cumulative tables — batch i contains batches 0..i:

src/layers/parquet-loader.ts:37

const partialTable = new Table(arrowTable.batches.slice(0, i + 1));
onBatch(i, partialTable);
But the consumer gives each emission a new layer id and appends without removing the previous one:

src/layers/layer-factory.ts:112 — const baseId = \${config.id}-batch-${batchIndex}`; src/hooks/use-map-layers.ts:36-38—setDeckLayers((prev) => [...prev, ...newLayers]);`

So a B-batch file ends with B × R live layers, where layer i holds batches 0..i. Batch 0's geometry is uploaded, styled, drawn and picked B times; batch 1, B−1 times. Total ≈ B(B+1)/2 batch-equivalents, all overdrawn at identical coordinates.

This is a hybrid of two valid strategies taking the worst of each. Same bug in src/layers/arrow-loader.ts:34 and streamParquetBatches (parquet-loader.ts:133-134, via a growing batches array).

Fix. Pick one strategy. Recommended: keep the cumulative table, make the id stable (${config.id}-batch-0, or just config.id) so each emission replaces the prior layer via deck's id-matched diff, and have addDeckLayers replace-by-id rather than blindly append. This keeps progressive rendering with one live layer set. The alternative — non-cumulative batches.slice(i, i+1) + append — also works and lets deck skip re-diffing settled batches, but changes what a "batch layer" means for picking and the top-layer ordering.

Watch the cache-hit path: table-cache.ts:32 emits the full table as onBatch(0, table), which lines up cleanly with a stable id.

Files: src/layers/parquet-loader.ts, src/layers/arrow-loader.ts, src/layers/layer-factory.ts:112, src/hooks/use-map-layers.ts:36-38.

2. COG per-pixel rule walk + hex parse ⭐ small diff, large win on 8 raster layers
src/layers/cog-style.ts:39-46 runs, for every pixel of every tile:

const rule = matchRule(style, properties);
const [r, g, b, a] = getFillColorFromRule(rule);
getFillColorFromRule (geostyler.ts:85-89) does a symbolizers.find(...) then hexToColor — three parseInts on substrings plus a fresh array (geostyler.ts:12-19) — per pixel. The comment at cog-style.ts:25 claims allocation is avoided; hexToColor reallocates anyway.

Fix. In buildCogColorFunction, precompute a rule → [r,g,b,a] array once (index-aligned with style.rules), and have the closure return the index from a rule match rather than re-extracting color. Removes essentially all per-pixel JS allocation.

3. JSON.stringify O(n²) dedupe in the click path — trivial fix
src/hooks/use-feature-pick.ts:93-95 and :142-144:

const isDuplicate = existing.some(
  (p) => JSON.stringify(p.properties) === JSON.stringify(feature.properties),
);
Full property-bag stringify, quadratic in picks, on every click. It exists only because the one-layer-per-rule fan-out plus the duplicate batch layers (#1) return the same feature many times.

Fix. Dedupe on a cheap stable key — (layer config id, row index) from the pick info — in a Set. Fixing #1 also shrinks n substantially.

4. Memoization: setProps in render body, fed fresh arrays at 60 Hz — medium
src/components/map/MapView.tsx:203 calls overlay.setProps({ layers }) in the render body, with a new array built at MapView.tsx:396 ([...layers, ...topLayers]) and another at App.tsx:538 ([...studyLayersA, ...markerLayersA, ...boxLayersA]). App.tsx:418 calls setViewState on every onMove frame, so this runs ~60×/sec during pan/zoom — twice per commit under StrictMode. Layer instances keep identity so the per-layer diff is a no-op, but the full setProps → _updateLayers pass runs regardless.

The memo chain is poisoned at the root: use-map-layers.ts:355-367 returns a fresh object literal and addLayer/removeLayer/hideLayer/addDeckLayers are plain function declarations, not useCallback. That invalidates all six Legend callbacks and defeats useNavigation's useMemo (use-navigation.ts:67,74-77) every render. There is no React.memo or context anywhere in src/, so Legend (309 lines), Sidebar (298), NavigationPanel (255) and ChartsPanel fully re-render on every map-move frame.

Also src/hooks/use-hover-cursor.ts:33-36: a useEffect with no dependency array plus an unmemoized clickableEntries filter — re-binds listeners every render.

Fix, in order:

useCallback the useMapLayers functions; useMemo its return object.
Move overlay.setProps into a useEffect; useMemo the merged layers array in MapView and the topLayers arrays in App.tsx.
Add the dep array to use-hover-cursor.ts:33 and memoize clickableEntries.
React.memo Legend / Sidebar / NavigationPanel / ChartsPanel.
5. Per-feature style resolution is O(features × rules²) — larger refactor, biggest structural win
createGeoArrowLayers emits one child layer per rule (layer-factory.ts:116-120), and each child gets an accessor that re-evaluates all rules to decide whether this rule is the winner:

src/layers/layer-factory.ts:70-74

return (info: ArrowAccessorInfo) => {
  const matched = matchRule(style, readRowProps(info, fields));
  if (!matched || matched.name !== rule.name) return TRANSPARENT;
  return extractor(matched);
};
Per row, per rule layer this does: (a) readRowProps allocating a fresh Record and doing a getChild(field) name lookup per filter field (layer-factory.ts:53-61); (b) matchRule linearly walking every rule (geostyler.ts:57-67); (c) extractor → symbolizers.find() + hexToColor re-parsing a hex string that is constant for the rule and known at construction time. withAreaFilter (layer-factory.ts:81-88) wraps each accessor in another per-row closure.

For a layer with F features and R rules this is ≈ F × R² rule evaluations and F × R hex parses. At R = 12 that's 144 rule-walks per feature. Every refreshAreaFilter (use-map-layers.ts:323-334) bumps updateTriggers.all on every layer and re-runs all of it.

Fix. The key insight: the color is invariant within a rule layer. The accessor only needs to answer "does this row match this rule?" So:

Compute a Uint8Array rule-index column once per table (single pass, F × R total, not F × R²), hoisting getChild lookups outside the loop — mirror the WeakMap column memoization already done correctly in src/layers/area-filter.ts:150-171.
Give each rule layer a constant getFillColor plus deck.gl's DataFilterExtension driven by that precomputed column, instead of a JS accessor. Moves per-feature style work to the GPU entirely.
Do this after #1 — the batch fix changes how many tables get styled.

6. Main-thread WASM parse + no code splitting — hardest, do last
parquet-loader.ts:66-68: the dominant format (76/76 vector layers) fully buffers then synchronously WASM-parses on the main thread — readGeoParquet blocks for the whole file. Only the unused parquet format gets the Range-request streaming path (parquet-loader.ts:114-149). No workers anywhere: grep for worker|loaders.gl across src/ returns one unrelated hit.
vite.config.ts is 14 lines — no manualChunks, no optimizeDeps. Zero React.lazy / dynamic import() in src/. parquet-wasm, @geoarrow/geoparquet-wasm, apache-arrow, maplibre-gl and the full deck stack ship in one chunk. deck.gl, @deck.gl/carto, @deck.gl/react are installed and never imported; shadcn is in dependencies (should be dev).
index.html loads the Google Maps JS API synchronously in <head> with a hardcoded API key — an unconditional third-party fetch on every page load, and an exposed credential. It is only used by street-view.tsx; load it lazily on demand.
table-cache.ts:47-54: clearTableCache/invalidateTableCache are exported but never called — all visited tables accumulate for the session. Not a speed bug, but a memory ceiling worth knowing about.
chart-data.ts:125,168,234: unyielded blocking loops over table.numRows with a String(value) allocation per row (area-filter.ts:186). Memoized per filter version, so once per filter change.
Fix. Move geoparquet parsing into a worker (transfer the ArrayBuffer in, transfer the IPC stream back). Drop the unused deck packages and declare @deck.gl/mapbox. Add manualChunks splitting the WASM/arrow/maplibre vendors. Lazy-load Google Maps.

Recommended order
#	Item	Effort	Payoff
1	Stable batch layer ids (stop quadratic overdraw)	S	Very high
2	Precompute COG rule→color table	S	High (raster)
3	Key-based pick dedupe	XS	Medium
4	Memoize useMapLayers + setProps in effect + React.memo	M	High (interaction)
5	Precomputed rule-index column + DataFilterExtension	L	Very high (vector)
6	Worker parsing, code splitting, dep cleanup	XL	High (load)
Items 1–4 are independent and can land in any order. Item 5 depends on 1.

Verification
No test suite exists in the repo, so verification is empirical — measure before and after each item:

Baseline first. npm run dev, load a heavy multi-batch geoparquet layer with many rules (the 12-rule layer), record a Chrome DevTools Performance profile of: initial layer load, a pan/zoom drag, an area-filter toggle, and a feature click.
Item 1: in the profile, confirm live deck layer count is now R not B × R (overlay._deck.layerManager.getLayers().length in console). Confirm the map still renders progressively during load and that features are picked once, not B times.
Item 2: compare tile-paint time on a COG layer; confirm identical rendered output pixel-for-pixel.
Item 3: click a dense feature cluster; confirm featureinfo shows the same unique features as before.
Item 4: React DevTools Profiler — confirm Legend/Sidebar/NavigationPanel no longer re-render during a pan drag, and that setProps fires only on real layer changes.
Item 5: confirm colors match the pre-change render exactly across all rules (screenshot diff), and that area-filter toggles no longer re-run JS per row.
Item 6: npm run build and check chunk sizes; confirm no main-thread long task during parse; confirm street view still works with lazy Google Maps.
Throughout: npx tsc -b and npm run lint clean; A/B comparison mode and the share/export preview map (which mounts a third deck instance, ExportPreviewMap.tsx:45) still work.

---

Implementation status (2026-07-15)

1. DONE — createGeoArrowLayers now uses stable ids (config.id, no batch suffix); addDeckLayers replaces by id (carrying over `visible` so mid-load legend toggles survive); use-study-area-layer replaces instead of accumulating. Loaders unchanged (cumulative emission kept, as recommended).
2. DONE — buildCogColorFunction precomputes an index-aligned rule→[r,g,b,a] table; the per-pixel closure walks filters once and writes from the table. No per-pixel allocation or hex parsing.
3. DONE, with one deviation — dedupe is now a Set keyed on `configId:JSON.stringify(props)` (stringify once per pick, O(n) total instead of O(n²) pairs). The plan's (config id, row index) key is unsafe: GeoArrow pick `info.index` is per record batch, so it collides across batches of one table.
4. DONE — useMapLayers fully useCallback'd + memoized return (addMvtLayer/addCogLayer hoisted to module scope); overlay.setProps moved into a useEffect; merged layer arrays memoized in MapView and App (topLayersA/B); use-hover-cursor got its dep array + memoized clickableEntries; Legend/Sidebar/NavigationPanel/ChartsPanel wrapped in React.memo, with the unstable props they receive stabilized (use-area-filter/use-box-select return objects memoized, Sidebar toolbar + sectionToggles + share button memoized, ChartsPanel onClose useCallback'd).
5. DONE, with one deviation — per-record-batch rule-index column (Int32Array, WeakMap-cached per batch × style, column handles hoisted): styling is now O(rows × rules) once per batch, accessors are O(1) per row with constant per-rule colors (no per-row matchRule, no per-row hex parse). The DataFilterExtension/GPU step was intentionally NOT taken: extension support on @geoarrow/deck.gl-layers composite layers is unverified at runtime, and the accessor path now costs O(1) per row anyway. Revisit only if area-filter toggles still profile hot.
6. PARTIAL —
   - DONE: @deck.gl/mapbox declared; unused deck.gl / @deck.gl/carto / @deck.gl/react removed; shadcn moved to devDependencies.
   - DONE: vite manualChunks splits vendor-deck / vendor-maplibre / vendor-arrow / vendor-parquet (function form — Vite 8/rolldown rejects the object form).
   - DONE: Google Maps script removed from index.html; street-view.tsx injects it on first Street View open (idempotent, retry on failure, "unavailable" state instead of endless spinner). Note the API key is still client-visible, as any Maps JS key is — restrict it by referrer in the Google console.
   - NOT DONE (deferred): worker-based geoparquet parsing — the XL item; main-thread WASM parse stands.
   - NOT DONE: table-cache eviction (memory ceiling note, no behavior change).

Verified: npx tsc -b clean; npm run build clean (chunks split as intended); npm run lint has the same 30 errors / 3 warnings as the pre-change baseline (all pre-existing). Runtime/profiling verification per the checklist above still to be done by hand.