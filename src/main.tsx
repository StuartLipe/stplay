import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PlayerOverlayApp } from './PlayerOverlayApp.tsx'

const isOverlay = window.location.hash === '#player-overlay'
if (isOverlay) {
  document.documentElement.classList.add('player-overlay-mode')
  document.body.style.background = 'transparent'
}
const devInternalTest = new URLSearchParams(window.location.search).get('devInternalTest') === '1'

async function mount() {
  const root = createRoot(document.getElementById('root')!)
  if (devInternalTest) {
    const { InternalPlayerTestRunner } = await import('./dev/InternalPlayerTestRunner.tsx')
    root.render(<InternalPlayerTestRunner />)
    return
  }
  root.render(isOverlay ? <PlayerOverlayApp /> : <App />)
}

void mount()
