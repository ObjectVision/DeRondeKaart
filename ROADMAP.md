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

- [ ] Define `layers.json` schema with uniform syntax (id, name, source url, style)
- [ ] Create a layer configuration loader that reads `layers.json`
- [ ] Install geoarrow/deck.gl-layers dependencies
- [ ] Implement GeoArrow/Parquet layer rendering for points, lines, and (multi)polygons
- [ ] Implement batch loading for GeoArrow/Parquet files with a new deck.gl child layer per batch
- [ ] Add example entries to `layers.json` for testing

## Stage 3: Additional Format Support

- [ ] Install and implement Mapbox Vector Tiles support via deck.gl MVTLayer
- [ ] Install and implement Cloud Optimized GeoTIFF (COG) support via deck.gl-raster
- [ ] Add MVT and COG example entries to `layers.json`
- [ ] Verify all four formats render correctly on the map

## Stage 4: UI Components — Legend & Map Controls

- [ ] Build legend component (bottom left position)
- [ ] Implement layer toggle (show/hide) from legend for GeoArrow, Parquet, and MVT layers
- [ ] Implement layer toggle for COG layers (if supported)
- [ ] Build map controls component (bottom right position): zoom in, zoom out
- [ ] Implement search tool in map controls
- [ ] Style all UI components with Tailwind CSS and shadcn/ui

## Stage 5: Dual Map Comparison with Slider

- [ ] Introduce Map A and Map B state containers
- [ ] Set default state: Map A visible, no layers loaded
- [ ] Implement central slider divider component
- [ ] Render Map A layers on the left side of the slider
- [ ] Render Map B layers on the right side of the slider
- [ ] Auto-trigger comparison mode when both Map A and Map B have layers
- [ ] Synchronize viewport (pan, zoom) between Map A and Map B

## Stage 6: URL Parameterization & Embed Support

- [ ] Define URL parameter schema for layer commands
- [ ] Implement "add layer to Map A / Map B" via URL params
- [ ] Implement "remove layer from Map A / Map B" via URL params
- [ ] Implement "hide layer in Map A / Map B" via URL params
- [ ] Implement "refresh" command via URL params
- [ ] Ensure URL param changes update the map without a full reload
- [ ] Test embedding in an iframe to verify embed compatibility

## Stage 7: Polish & Optimization

- [ ] Review and optimize batch loading performance
- [ ] Ensure responsive layout for various embed sizes (dashboards, Power BI)
- [ ] Add error handling for failed layer loads and invalid configurations
- [ ] Final review of all features against CLAUDE.md specification
