import { coverSrc } from './proxy'

export type PosterTint = {
  rgb: string
}

const cache = new Map<string, PosterTint | null>()
const MAX_CACHE = 400

function trimCache() {
  if (cache.size <= MAX_CACHE) return
  const first = cache.keys().next().value
  if (first) cache.delete(first)
}

function sampleDominant(data: Uint8ClampedArray): [number, number, number] | null {
  let r = 0
  let g = 0
  let b = 0
  let n = 0

  for (let i = 0; i < data.length; i += 4) {
    const pr = data[i]
    const pg = data[i + 1]
    const pb = data[i + 2]
    const pa = data[i + 3]
    if (pa < 128) continue
    const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb
    if (lum < 28 || lum > 230) continue
    const sat = Math.max(pr, pg, pb) - Math.min(pr, pg, pb)
    if (sat < 18) continue
    r += pr
    g += pg
    b += pb
    n += 1
  }

  if (n < 8) {
    r = 0
    g = 0
    b = 0
    n = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      n += 1
    }
    if (!n) return null
  }

  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

function soften([r0, g0, b0]: [number, number, number]): string {
  const r = Math.min(255, Math.round(r0 * 0.62 + 18))
  const g = Math.min(255, Math.round(g0 * 0.62 + 18))
  const b = Math.min(255, Math.round(b0 * 0.62 + 18))
  return `${r}, ${g}, ${b}`
}

export async function loadPosterTint(rawUrl?: string): Promise<PosterTint | null> {
  const url = coverSrc(rawUrl)
  if (!url) return null
  if (cache.has(url)) return cache.get(url) ?? null

  const tint = await new Promise<PosterTint | null>((resolve) => {
    const img = new Image()
    // sturplay://cover já contorna CORS; anonymous só para http(s) direto
    if (/^https?:\/\//i.test(url)) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const size = 32
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, size, size)
        const rgb = sampleDominant(ctx.getImageData(0, 0, size, size).data)
        if (!rgb) {
          resolve(null)
          return
        }
        resolve({ rgb: soften(rgb) })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })

  trimCache()
  cache.set(url, tint)
  return tint
}
