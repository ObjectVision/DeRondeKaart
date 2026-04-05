# Roadmap

Implementation stages for the embeddable webmap application. Each stage builds on the previous.

---

## Stage 1: Project Scaffolding & Base Map

- [x] Initialize Vite project with React and TypeScript
- [x] Install and configure Tailwind CSS
- [x] Install and configure shadcn/ui
- [x] Install standalone deck.gl and CARTO basemap dependencies
- [x] Render a basic deck.gl map with a CARTO basemap
- [x] Disable map tilting and rotation via deck.gl controller settings
- [x] Verify the app builds and runs with `npm run dev`

## Stage 2: Layer Configuration & GeoArrow/Parquet Support

- [x] Define `layers.json` schema with uniform syntax (id, name, source url, style)
- [x] Create a layer configuration loader that reads `layers.json`
- [x] Install geoarrow/deck.gl-layers dependencies
- [x] Implement GeoArrow/Parquet layer rendering for points, lines, and (multi)polygons
- [x] Implement batch loading for GeoArrow/Parquet files with a new deck.gl child layer per batch
- [x] Add example entries to `layers.json` for testing

## Stage 3: Additional Format Support

- [x] Install and implement Mapbox Vector Tiles support via deck.gl MVTLayer
- [x] Install and implement Cloud Optimized GeoTIFF (COG) support via MapLibre COG protocol
- [x] Add MVT and COG example entries to `layers.json`
- [x] Verify all four formats render correctly on the map

## Stage 4: UI Components — Legend & Map Controls

- [x] Build legend component (bottom left position)
- [x] Implement layer toggle (show/hide) from legend for GeoArrow, Parquet, and MVT layers
- [x] Implement layer toggle for COG layers (if supported)
- [x] Build map controls component (bottom right position): zoom in, zoom out
- [x] Implement search tool in map controls
- [x] Style all UI components with Tailwind CSS and shadcn/ui

## Stage 5: Dual Map Comparison with Slider

- [x] Introduce Map A and Map B state containers
- [x] Set default state: Map A visible, no layers loaded
- [x] Implement central slider divider component
- [x] Render Map A layers on the left side of the slider
- [x] Render Map B layers on the right side of the slider
- [x] Auto-trigger comparison mode when both Map A and Map B have layers
- [x] Synchronize viewport (pan, zoom) between Map A and Map B

## Stage 6: URL Parameterization & Embed Support

- [x] Define URL parameter schema for layer commands
- [x] Implement "add layer to Map A / Map B" via URL params
- [x] Implement "remove layer from Map A / Map B" via URL params
- [x] Implement "hide layer in Map A / Map B" via URL params
- [x] Implement "refresh" command via URL params
- [x] Ensure URL param changes update the map without a full reload
- [x] Test embedding in an iframe to verify embed compatibility

## Stage 7: Polish & Optimization

- [x] Review and optimize batch loading performance
- [x] Ensure responsive layout for various embed sizes (dashboards, Power BI)
- [x] Add error handling for failed layer loads and invalid configurations
- [x] Final review of all features against CLAUDE.md specification

## Stage 8: GeoStyler Style Specification

- [x] Define GeoStyler-based style types (rules, filters, symbolizers for Fill, Line, Mark)
- [x] Update `LayerConfig` and `layers.json` schema to use GeoStyler `rules` syntax
- [x] Implement GeoStyler rule interpreter for GeoArrow/Parquet layers (attribute-based conditional styling)
- [x] Implement GeoStyler rule interpreter for MVT layers (attribute-based conditional styling)
- [x] Support fallback/default symbolizer when no filter matches
- [x] Update example `layers.json` entries with GeoStyler rule-based styles
- [ ] Verify styled layers render correctly with conditional colors per feature class

## Stage 9: Legend — GeoStyler Class Visualization

- [x] Update legend to display individual rule classes per layer (name + color swatch from symbolizer)
- [x] Implement per-class toggle: clicking a class hides/shows features matching that rule's filter
- [x] Show legend classes for both Map A and Map B in comparison mode
- [x] Handle COG layers in legend (no rule classes, keep simple layer-level toggle)
- [x] Ensure legend updates dynamically when layers are added/removed via URL commands

## Stage 10: Final Integration & Testing

- [ ] Verify GeoStyler styles work across all vector formats (GeoArrow, Parquet, MVT)
- [ ] Update `test-embed.html` to test class-level toggling via postMessage
- [ ] Final review of legend and styling against STYLE.md specification
