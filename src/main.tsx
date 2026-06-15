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
      />
    </StrictMode>,
  )
}

bootstrap()
