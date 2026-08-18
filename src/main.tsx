import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { loadMapConfig, toInitialViewState } from '@/config/map-config'
import { dismissSplash } from '@/lib/splash'

async function bootstrap() {
  const mapConfig = await loadMapConfig()
  // `?embed=circular` boots straight into the standalone circular-export view
  // (only the circle + legend + title) for embedding on a webpage.
  const embedCircular =
    new URLSearchParams(window.location.search).get('embed') === 'circular'
  // That view mounts no MapView, so the map's onLoad — which dismisses the
  // splash everywhere else — never fires here.
  if (embedCircular) dismissSplash()
  render(
    () => (
      <App
        embedCircular={embedCircular}
        initialViewState={toInitialViewState(mapConfig)}
        studyAreaId={mapConfig.studyarea}
        pickLayerId={mapConfig.pickLayer}
        streetviewEnabled={mapConfig.streetview ?? false}
        searchbarEnabled={mapConfig.searchbar}
        navigationEnabled={mapConfig.navigation}
        navigationMode={mapConfig.navigationMode}
        filterSectionEnabled={mapConfig.filterSection}
        navigationSectionEnabled={mapConfig.navigationSection}
        chartsPanelEnabled={mapConfig.chartsPanel}
        shareEnabled={mapConfig.share}
        filterFlyToEnabled={mapConfig.filterFlyTo}
        combinationsEnabled={mapConfig.combinations}
        annotationsEnabled={mapConfig.annotations}
        mapControls={mapConfig.mapControls}
        clickMarker={mapConfig.clickMarker}
        basemapDefault={mapConfig.basemap}
      />
    ),
    document.getElementById('root')!,
  )
}

// A failed boot leaves #root empty. Without this the splash would stay up over
// nothing, reading as a hang rather than an error.
bootstrap().catch((err) => {
  dismissSplash()
  console.error('Kon de applicatie niet starten', err)
})
