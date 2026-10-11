import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PlayerOverlayApp } from './PlayerOverlayApp.tsx'
import { seedSavedEndpoints } from './dev/seed-endpoints.ts'

const isOverlay = window.location.hash === '#player-overlay'
if (isOverlay) {
  document.documentElement.classList.add('player-overlay-mode')
  document.body.style.background = 'transparent'
}
const devInternalTest = new URLSearchParams(window.location.search).get('devInternalTest') === '1'

// Atalhos de desenvolvimento, sem UI.
//   ?devSeed=1      completa a senha da playlist ja cadastrada
//   ?devCleanSeed=1 remove as playlists seed-* que o seed antigo criou
//
// Fora de DEV o import nem chega a resolver, entao nada disso vira bundle.
const params = new URLSearchParams(window.location.search)
const devSeed = import.meta.env.DEV && params.get('devSeed') === '1'
const devCleanSeed = import.meta.env.DEV && params.get('devCleanSeed') === '1'

async function mount() {
  if (devCleanSeed) {
    const { cleanSeedPlaylists } = await import('./dev/clean-seed.ts')
    console.info('[dev] limpeza de seed:', cleanSeedPlaylists())
  }
  if (devSeed) {
    const result = await seedSavedEndpoints()
    console.info('[dev] seed de senhas:', result)
  }
  const root = createRoot(document.getElementById('root')!)
  if (devInternalTest) {
    const { InternalPlayerTestRunner } = await import('./dev/InternalPlayerTestRunner.tsx')
    root.render(<InternalPlayerTestRunner />)
    return
  }
  root.render(isOverlay ? <PlayerOverlayApp /> : <App />)
}

void mount()
