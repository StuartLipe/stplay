const store = new Map<string, { value: unknown; at: number }>()
const inflight = new Map<string, Promise<unknown>>()

/**
 * TTL + teto de tamanho.
 *
 * Era um Map puro: sem validade e sem limite. Todo filme que o usuario abria
 * ficava retido com o `plot` inteiro pelo resto do processo, num app desktop
 * que fica dias aberto. Pior: a chave é `${playlistId}:${vodId}` — quando a
 * credencial da playlist era corrigida, a conta nova herdava o metadata da
 * conta antiga, porque nada invalidava.
 */
const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500

function evict() {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(key)
  }
  // Inserção em ordem: o Map itera do mais antigo pro mais novo.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
}

/**
 * Chave do cache de metadata de VOD.
 *
 * O comentario aqui dizia "o host entra na chave" e era FALSO: a chave e
 * `${playlistId}:${vodId}`, e nada mais. O `playlistId` sobrevive a troca de
 * usuario/senha, entao o synopsis e a capa de um id vinham da conta anterior.
 *
 * Nao coloquei host na chave por conta propria porque a assinatura e usada em
 * varias call-sites e mudar a forma da chave invalida o cache em voo de forma
 * silenciosa. O que fecha o problema de verdade e a invalidacao explicita:
 * `updatePlaylist` no `App.tsx` detecta mudanca de host/usuario/senha e chama
 * `clearVodInfoCache()`/`clearSeriesInfoCache()`. Antes esses `clear*` nao eram
 * chamados por NINGUEM, so expiravam por TTL.
 */
export function vodInfoCacheKey(playlistId: string, vodId: string) {
  return `${playlistId}:${vodId}`
}

export function peekVodInfoCache(key: string): unknown {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > TTL_MS) {
    store.delete(key)
    return undefined
  }
  return entry.value
}

export function setVodInfoCache(key: string, value: unknown) {
  store.set(key, { value, at: Date.now() })
  if (store.size > MAX_ENTRIES) evict()
}

export function clearVodInfoCache() {
  store.clear()
  inflight.clear()
}

export function coalesceVodInfoLoad<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const pending = factory().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  inflight.set(key, pending)
  return pending
}
