import { coverSrc } from './proxy'

const prefetched = new Set<string>()

/** Prefetch leve das capas visíveis (via cover-cache no desktop). */
export function prefetchCovers(urls: Array<string | undefined>, limit = 16) {
  let n = 0
  for (const raw of urls) {
    if (n >= limit) break
    const src = coverSrc(raw)
    if (!src || prefetched.has(src)) continue
    prefetched.add(src)
    n += 1
    const img = new Image()
    img.decoding = 'async'
    img.loading = 'eager'
    img.src = src
  }
  if (prefetched.size > 2000) prefetched.clear()
}

export async function clearCoverCache() {
  try {
    await window.sturplay?.clearCoverCache?.()
  } catch {
    // ignore
  }
  prefetched.clear()
}
