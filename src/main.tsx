import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import {
  complementaryDashboardEnabled,
  loadMapConfig,
  standaloneDashboardEnabled,
  toInitialViewState,
} from '@/config/map-config'
import { initVariants } from '@/config/variant'
import { dismissSplash } from '@/lib/splash'

async function bootstrap() {
  const mapConfig = await loadMapConfig()
  // Before anything fetches layers.json or navigation.json: those two resolve
  // through the active variant, so the variant has to be chosen first.
  initVariants(mapConfig.variants)
  // `?mode=dashboard` boots the map-less dashboard, when map.json allows it.
  // The capability wins over the URL: a link shared into a project that does
  // not offer the dashboard opens the map rather than an error.
  if (new URLSearchParams(window.location.search).get('mode') === 'dashboard') {
    if (standaloneDashboardEnabled(mapConfig.dashboard)) {
      // Like the circular embed below: no MapView mounts, so the map's onLoad —
      // which dismisses the splash everywhere else — never fires here.
      dismissSplash()
      // Dynamic: this is what keeps the dashboard and DuckDB out of the map
      // application's bundle entirely.
      const { DashboardApp } = await import('@/dashboard/standalone')
      render(() => <DashboardApp />, document.getElementById('root')!)
      return
    }
    console.warn(
      `map.json: dashboard "${mapConfig.dashboard}"; ?mode=dashboard ignored`,
    )
  }
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
        pickLayerRightId={mapConfig.pickLayerRight}
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
        complementaryDashboardEnabled={complementaryDashboardEnabled(mapConfig.dashboard)}
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
