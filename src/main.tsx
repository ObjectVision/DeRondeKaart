import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadMapConfig, toInitialViewState } from '@/config/map-config'

async function bootstrap() {
  const mapConfig = await loadMapConfig()
  // `?embed=circular` boots straight into the standalone circular-export view
  // (only the circle + legend + title) for embedding on a webpage.
  const embedCircular =
    new URLSearchParams(window.location.search).get('embed') === 'circular'
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
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
        annotationsEnabled={mapConfig.annotations}
        mapControls={mapConfig.mapControls}
        clickMarker={mapConfig.clickMarker}
        basemapDefault={mapConfig.basemap}
      />
    </StrictMode>,
  )
}

bootstrap()
