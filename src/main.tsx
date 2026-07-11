import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadMapConfig, toInitialViewState } from '@/config/map-config'

async function bootstrap() {
  const mapConfig = await loadMapConfig()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App
        initialViewState={toInitialViewState(mapConfig)}
        studyAreaId={mapConfig.studyarea}
        streetviewEnabled={mapConfig.streetview ?? false}
        searchbarEnabled={mapConfig.searchbar}
        navigationEnabled={mapConfig.navigation}
        navigationMode={mapConfig.navigationMode}
        filterSectionEnabled={mapConfig.filterSection}
        navigationSectionEnabled={mapConfig.navigationSection}
        chartsPanelEnabled={mapConfig.chartsPanel}
        shareEnabled={mapConfig.share}
        mapControls={mapConfig.mapControls}
        clickMarker={mapConfig.clickMarker}
      />
    </StrictMode>,
  )
}

bootstrap()
