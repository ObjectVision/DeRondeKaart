Goal: create a webmap app that is embedable given the following conditions:

general
- use typescript
- use react.js framework with vite
- two available maps: map A and map B
- default state is no layers added, map A visible with a chosen default basemap
- do not interact with the git interface of this project, commits will be handled by a human

libraries
- use standalone deck.gl 
- use tailwind.cs and shadcn/ui for ui components

supported fileformats
- geoarrow and parquet through [deck.gl](https://github.com/geoarrow/deck.gl-layers#readme) for points, lines and (multi)polygons
- Mapbox Vector Tiles through maplibre.gl https://maplibre.org/maplibre-gl-js/docs/API/classes/VectorTileSource/
- Basemap through deck.gl https://deck.gl/docs/api-reference/carto/basemap
- cloud optimized geotif (COG) through https://www.npmjs.com/package/@developmentseed/deck.gl-geotiff

features
- legend, location: bottom left, visual representation of STYLE.md spec
- for fileformats: geoarrow, parquet, Mapbox Vector Tiles and if possible the COG format classes should be toggleble from the legend by clicking
- mapcontrols: search-tool, zoom-in, zoom-out, location: bottom right
- comparison of two maps A and B with central slider (left of the slider shows map A with loaded layers, right of the slider shows map B with loaded layers)
- for the geoarrow and parquet implementation, load the files in batches, and create a new deck.gl child layer per batch

deck.gl parmeterization
- no map tilting
- no map rotation

interface
- the webmap will mainly be embedded in websites and dashboards like power-bi, therefore the main interface will make use of url-parameterization
- available url-parameterization controls: add layer to map A, add layer to map B, remove layer from map A, remove layer from map B, hide layer in map A, hide layer in map B
- comparison will be automatically triggered once layer(s) are loaded to map A and map B
- url-parameterization changes do not reload the map but rather change the content based on the command, unless the command is to refresh

layer configuration
- layers will be configured for use on the server by editing a layers.json file
- a uniform syntax for each layer in the layers.json file given the four available supported fileformats
- each layer definition has at least the following components: id, name, source url (ie. https://path/to/points.parquet), style
- style follows the specification in STYLE.md

featureinfo
- an intersecting click on features in map A or map B triggers featureinfo
- featureinfo is specified for a given layer using html templating
- the html template can be either inlined in layers.json or inside a layer definition a reference can be made to a .html file containing the template
- template parameters have form: [[ parameter ]]
- featureinfo is shown in a rectangular window in line with the style of the legend
- if more than one feature is clicked of the same layer, the rectangular box is scrollable
- if features of multiple layers are clicked, each layer has it's own page inside the featureinfo window

small screen behavior
- make all three subwindows: legend, featureinfo, navigation (search, +, -) drag-expandable or collapsible
- the current size of the window should be made persistent for the current session
- two available windows should automatically deal with collapsing: legend and navigation tools (search, +, -)
- collapse navigation tools first to a single icon based on current window size, clicking the icon will reinstate view of the navigation tools before collapse
- collapse legend secondary first to a single icon based on current window size, clicking the icon will reinstate view of the legend before collapse