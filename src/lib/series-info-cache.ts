const store = new Map<string, { value: unknown; at: number }>()
const inflight = new Map<string, Promise<unknown>>()

/** Mesmas regras do vod-info-cache: TTL, teto, e nada herdado entre contas. */
const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500

function evict() {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key)
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
}

export function seriesInfoCacheKey(playlistId: string, seriesId: string) {
  return `${playlistId}:${seriesId}`
}

export function peekSeriesInfoCache(key: string): unknown {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(key)
    return undefined
  }
  return entry.value
}

export function setSeriesInfoCache(key: string, value: unknown) {
  store.set(key, { value, at: Date.now() })
  if (store.size > MAX_ENTRIES) evict()
}

export function clearSeriesInfoCache() {
  store.clear()
  inflight.clear()
}

export function coalesceSeriesInfoLoad<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const pending = factory().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  inflight.set(key, pending)
  return pending
}
