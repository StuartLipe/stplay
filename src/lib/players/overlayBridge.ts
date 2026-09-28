import type { VideoRect } from './types'

const OVERLAY_BAR_HEIGHT = 80

export function overlayBarRect(rect: VideoRect): VideoRect {
  const h = Math.min(OVERLAY_BAR_HEIGHT, Math.max(48, Math.round(rect.height * 0.12)))
  return {
    x: rect.x,
    y: rect.y + rect.height - h,
    width: rect.width,
    height: h,
  }
}

let observer: ResizeObserver | null = null
let raf = 0
let lastPublishedKey = ''

export function measureVideoRect(element: HTMLElement | null): VideoRect | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 32 || rect.height < 32) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function watchVideoBounds(element: HTMLElement | null, onBounds: (rect: VideoRect) => void) {
  stopWatchingVideoBounds()
  if (!element) return

  const publish = () => {
    const rect = measureVideoRect(element)
    if (!rect) return
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (key === lastPublishedKey) return
    lastPublishedKey = key
    onBounds(rect)
  }

  const schedule = () => {
    window.cancelAnimationFrame(raf)
    raf = window.requestAnimationFrame(publish)
  }

  observer = new ResizeObserver(schedule)
  observer.observe(element)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  document.addEventListener('fullscreenchange', schedule)
  schedule()

  return () => {
    stopWatchingVideoBounds()
  }
}

export function stopWatchingVideoBounds() {
  window.cancelAnimationFrame(raf)
  lastPublishedKey = ''
  observer?.disconnect()
  observer = null
}

export async function syncOverlayBounds(rect: VideoRect) {
  await window.sturplay?.player?.setBounds?.(rect)
}
