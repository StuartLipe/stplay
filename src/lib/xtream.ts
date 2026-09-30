import type { Channel, ContentDetails, Playlist, SeriesInfo, ShortEpg, XtreamProfile } from '../types'
import { parseM3u } from './m3u'
import { matchLiveStream } from './live-stream-match'
import { fetchJson, fetchText, PANEL_LARGE_TIMEOUT_MS } from './proxy'
import {
  coalesceSeriesInfoLoad,
  peekSeriesInfoCache,
  seriesInfoCacheKey,
  setSeriesInfoCache,
} from './series-info-cache'
import {
  coalesceVodInfoLoad,
  peekVodInfoCache,
  setVodInfoCache,
  vodInfoCacheKey,
} from './vod-info-cache'

type XtreamUser = {
  user_info?: { auth?: number; status?: string; username?: string; exp_date?: string | number | null }
  server_info?: { url?: string; port?: string; https_port?: string; server_protocol?: string }
}

type Category = { category_id: string; category_name: string }

type LiveStream = {
  stream_id: number
  name: string
  stream_icon?: string
  category_id?: string
  epg_channel_id?: string
}

type VodStream = LiveStream & {
  container_extension?: string
  plot?: string
  movie_image?: string
  cover_big?: string
  cover?: string
  added?: string | number
  releaseDate?: string
  release_date?: string
  releasedate?: string
  year?: string | number
  release_year?: string | number
  rating?: string | number
}

type SeriesItem = {
  series_id: number
  name: string
  cover?: string
  category_id?: string
  plot?: string
  last_modified?: string | number
  releaseDate?: string
  release_date?: string
  releasedate?: string
  year?: string | number
  release_year?: string | number
  rating?: string | number
}

const PLOT_KEY_RE =
  /^(o_?)?(plot|description|overview|synopsis|sinopse|descricao|storyline|story|resumo|longdescription|shortdescription|movie_?description|movie_?plot)$/i
const PLOT_SKIP_KEYS = new Set([
  'audio',
  'video',
  'audio_info',
  'video_info',
  'backdrop',
  'backdrop_path',
  'subtitles',
  'cover',
  'covers',
  'stream_icon',
  'movie_image',
  'cover_big',
  'youtube_trailer',
  'bitrate',
  'director',
  'actors',
  'cast',
  'genre',
  'name',
  'o_name',
  'title',
  'releasedate',
  'release_date',
  'added',
  'duration',
  'duration_secs',
  'rating',
  'country',
  'age',
])

function coerceRecord(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return coerceRecord(JSON.parse(trimmed))
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (Array.isArray(value)) {
    const merged: Record<string, unknown> = {}
    for (const item of value) {
      const rec = coerceRecord(item)
      if (rec) Object.assign(merged, rec)
    }
    return Object.keys(merged).length ? merged : undefined
  }
  if (typeof value === 'object') return value as Record<string, unknown>
  return undefined
}

function decodePlotEntities(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function cleanPlotText(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (Array.isArray(raw)) {
    const joined = raw.map((item) => cleanPlotText(item)).filter(Boolean).join('\n')
    return cleanPlotText(joined)
  }
  if (typeof raw === 'object') {
    const fromKeys = pickPlot(raw as Record<string, unknown>)
    if (fromKeys) return fromKeys
    let best: string | undefined
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const text = cleanPlotText(value)
      if (text && (!best || text.length > best.length)) best = text
    }
    return best
  }
  let text = decodePlotEntities(String(raw))
  try {
    if (/%[0-9A-Fa-f]{2}/.test(text)) text = decodeURIComponent(text)
  } catch {
    // ignore
  }
  text = text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (text.length < 20) return undefined
  if (/^(n\/a|na|null|undefined|-|sem (sinopse|descricao|descrição))$/i.test(text)) return undefined
  return text
}

function pickPlotFromRecord(record: Record<string, unknown>, depth: number): string | undefined {
  if (depth > 4) return undefined
  let best: string | undefined
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === '') continue
    const normalized = key.toLowerCase().replace(/[\s-]/g, '_')
    if (PLOT_KEY_RE.test(normalized)) {
      const text = cleanPlotText(value)
      if (text && (!best || text.length > best.length)) best = text
      continue
    }
    if (PLOT_SKIP_KEYS.has(normalized) || depth >= 4) continue
    const nested = coerceRecord(value)
    if (!nested) continue
    const fromNested = pickPlotFromRecord(nested, depth + 1)
    if (fromNested && (!best || fromNested.length > best.length)) best = fromNested
  }
  return best
}

/** Sinopse do filme/série nos campos que o painel manda (plot, description, overview, TMDB aninhado…). */
function pickPlot(...sources: unknown[]): string | undefined {
  let best: string | undefined
  for (const source of sources) {
    if (source == null) continue
    const direct = cleanPlotText(typeof source === 'object' ? undefined : source)
    if (direct && (!best || direct.length > best.length)) best = direct
    const record = coerceRecord(source)
    if (!record) continue
    const fromRecord = pickPlotFromRecord(record, 0)
    if (fromRecord && (!best || fromRecord.length > best.length)) best = fromRecord
  }
  return best
}

function cleanSearchTitle(name: string): string {
  return String(name || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchItunesPlot(name: string, year?: string, entity: 'movie' | 'tvShow' = 'movie'): Promise<string | undefined> {
  const term = cleanSearchTitle(name)
  if (term.length < 3) return undefined
  const yearHint = String(year || '').match(/\b((?:19|20)\d{2})\b/)?.[1]
  for (const country of ['BR', 'US']) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=8&country=${country}`
      const data = await fetchJson<{
        results?: Array<{ trackName?: string; collectionName?: string; longDescription?: string; shortDescription?: string; releaseDate?: string }>
      }>(url, { timeoutMs: 7000 })
      const rows = data.results || []
      const wanted = term.toLocaleLowerCase('pt-BR')
      const ranked = rows
        .map((row) => {
          const plot = cleanPlotText(row.longDescription || row.shortDescription)
          if (!plot) return null
          const title = String(row.trackName || row.collectionName || '').toLocaleLowerCase('pt-BR')
          const rowYear = String(row.releaseDate || '').slice(0, 4)
          let score = 0
          if (title && (title.includes(wanted) || wanted.includes(title))) score += 4
          else {
            const words = wanted.split(' ').filter((w) => w.length > 3)
            const hits = words.filter((w) => title.includes(w)).length
            if (!hits) return null
            score += hits
          }
          if (yearHint && rowYear === yearHint) score += 3
          else if (yearHint && rowYear && rowYear !== yearHint) score -= 2
          return { plot, score }
        })
        .filter((row): row is { plot: string; score: number } => Boolean(row))
        .sort((a, b) => b.score - a.score)
      if (ranked[0] && ranked[0].score >= 3) return ranked[0].plot
    } catch {
      // iTunes é só fallback da sinopse
    }
  }
  return undefined
}

/** Pega lançamento do filme/série nos campos que o painel costuma mandar na lista. */
function pickStreamReleaseDate(item: {
  releaseDate?: string
  release_date?: string
  releasedate?: string
  year?: string | number
  release_year?: string | number
}): string | undefined {
  const candidates = [
    item.releaseDate,
    item.release_date,
    item.releasedate,
    item.year,
    item.release_year,
  ]
  for (const value of candidates) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (!text || /^(null|undefined|n\/a|-|0)$/i.test(text)) continue
    return text
  }
  return undefined
}

function normalizeHost(host: string) {
  return host.replace(/\/+$/, '')
}

function formatExpDate(rawExp: string | number | null | undefined) {
  if (rawExp === null || rawExp === undefined || rawExp === 0 || rawExp === '0' || rawExp === 'null' || rawExp === 'unlimited') {
    return null
  }
  const timestamp = Number(rawExp)
  if (!Number.isNaN(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000).toLocaleDateString('pt-BR')
  }
  return String(rawExp)
}

function xtreamBase(playlist: Playlist) {
  if (!playlist.xtream) throw new Error('Playlist Xtream incompleta')
  return normalizeHost(playlist.xtream.host)
}

/** Mesmo formato do IPTV Expert — catálogo completo de uma vez. */
function xtreamM3uUrl(playlist: Playlist, output: 'ts' | 'm3u8' = 'ts') {
  const { username, password } = playlist.xtream!
  return `${xtreamBase(playlist)}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=${output}`
}

function apiUrl(playlist: Playlist, extra = '') {
  const { username, password } = playlist.xtream!
  const q = extra ? `&${extra}` : ''
  return `${xtreamBase(playlist)}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}${q}`
}

function absLogo(playlist: Playlist, logo?: string) {
  const value = logo?.trim()
  if (!value) return undefined
  if (value.startsWith('/')) return `${xtreamBase(playlist)}${value}`
  return value
}

function liveUrl(playlist: Playlist, streamId: string | number, ext = 'm3u8') {
  const { username, password } = playlist.xtream!
  return `${xtreamBase(playlist)}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`
}

function vodUrl(playlist: Playlist, streamId: string | number, ext = 'mp4') {
  const { username, password } = playlist.xtream!
  return `${xtreamBase(playlist)}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`
}

function seriesUrl(playlist: Playlist, id: string | number, ext = 'mp4') {
  const { username, password } = playlist.xtream!
  return `${xtreamBase(playlist)}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`
}

export async function testXtream(playlist: Playlist): Promise<{ profile: XtreamProfile }> {
  const data = await fetchJson<XtreamUser>(apiUrl(playlist))
  // Alguns forks devolvem `auth` como string ("0"). `=== 0` não pega, e a conta
  // inválida passava pelo teste de conexão como se estivesse saudável.
  const auth = Number(data.user_info?.auth)
  if (!Number.isFinite(auth) || auth === 0) throw new Error('Usuário ou senha inválidos')
  const status = String(data.user_info?.status ?? '').toLowerCase()
  if (status && status !== 'active') throw new Error(`Conta ${status} — assinatura não ativa`)
  let domain = data.server_info?.url || playlist.xtream?.host || ''
  try {
    domain = new URL(domain).hostname
  } catch {
    domain = domain.replace(/^https?:\/\//i, '').split('/')[0]
  }
  return {
    profile: {
      username: data.user_info?.username || playlist.xtream?.username || '',
      expDate:
        data.user_info?.exp_date === undefined || data.user_info.exp_date === null
          ? null
          : formatExpDate(data.user_info.exp_date),
      domain,
    },
  }
}

/**
 * Converte playlist M3U do painel (get.php?username=&password=) em Xtream
 * para usar player_api — sem isso o M3U trunca em ~3k e some categorias.
 */
export function toXtreamPlaylist(playlist: Playlist): Playlist | null {
  if (playlist.kind === 'xtream' && playlist.xtream?.host && playlist.xtream.username && playlist.xtream.password) {
    return playlist
  }
  const url = playlist.m3uUrl
  if (!url) return null
  try {
    const source = new URL(url)
    const username = source.searchParams.get('username')
    const password = source.searchParams.get('password')
    if (!username || !password) return null
    return {
      id: playlist.id,
      name: playlist.name,
      kind: 'xtream',
      xtream: { host: source.origin, username, password, profile: playlist.xtream?.profile },
    }
  } catch {
    return null
  }
}

export async function loadM3uAccountProfile(playlist: Playlist): Promise<XtreamProfile | null> {
  const xtreamPlaylist = toXtreamPlaylist(playlist)
  if (!xtreamPlaylist || playlist.kind !== 'm3u') return null
  return (await testXtream(xtreamPlaylist)).profile
}

function getCatId(c: unknown): string {
  if (!c || typeof c !== 'object') return ''
  const item = c as Record<string, unknown>
  return String(item.category_id ?? item.id ?? item.cat_id ?? '').trim()
}

function getCatName(c: unknown): string {
  if (!c || typeof c !== 'object') return ''
  const item = c as Record<string, unknown>
  return String(item.category_name ?? item.name ?? item.category ?? '').trim()
}

function getStreamCatId(s: unknown): string {
  if (!s || typeof s !== 'object') return ''
  const item = s as Record<string, unknown>
  // category_id explícito tem prioridade (inclui o que forçamos no fetch por categoria)
  const direct = item.category_id ?? item.cat_id
  if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
    return String(direct).trim()
  }
  if (Array.isArray(item.category_ids) && item.category_ids.length > 0) {
    return String(item.category_ids[0]).trim()
  }
  return ''
}

function isAdultCategoryName(name: string): boolean {
  return /ADULTO|ADULTA|\+18|18\+|XXX|ONLYFANS|PRIVACY|PORNO|PORNÔ|PORN|HENTAI|SEXTREME|EROTIC|PRIVE|PRIVÊ|CINE\s*PRIV|BRAZZER|BANG\s*BROS|PLAYBOY|VENUS|FETISH|SEXXX/i.test(
    name,
  )
}

/**
 * Sinaliza "sessão inválida" para o retry loop saber que NÃO deve repetir.
 * Sem isso, `loadXtreamVodCategory` gastava 1,2 + 2,4 + 3,6 + 4,8 + 6 = 18s de
 * backoff numa conta expirada, e o `loadXtreamVod` ainda repetia por categoria:
 * dezenas de segundos de "Carregando filmes…" e depois grade vazia, sem erro.
 */
class AuthExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthExpiredError'
  }
}

function isAuthExpired(error: unknown): boolean {
  return error instanceof AuthExpiredError || (error instanceof Error && error.name === 'AuthExpiredError')
}

function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    // Sessão inválida/expirada devolve um envelope, não uma lista:
    //   { user_info: { auth: 0, ... }, server_info: {...} }
    // Object.values transformava isso em 2 "canais" sem nome apontando para
    // /live/user/pass/undefined.m3u8 — o usuário via 2 entradas quebradas em vez
    // de "login inválido".
    const record = data as Record<string, unknown>
    if (record.user_info) {
      const auth = Number((record.user_info as { auth?: unknown }).auth)
      if (!Number.isFinite(auth) || auth === 0) throw new AuthExpiredError('Sessão inválida ou expirada — confira usuário e senha')
      throw new Error('Resposta inesperada do painel (sem lista de itens)')
    }
    return Object.values(record as Record<string, T>)
  }
  return []
}

/** Limita requisições paralelas — servidores Xtream costumam dropar dezenas de hits ao mesmo tempo. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) || 1 }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function loadXtreamLive(playlist: Playlist): Promise<Channel[]> {
  const [catsRaw, rawStreams] = await Promise.all([
    fetchJson<Category[]>(apiUrl(playlist, 'action=get_live_categories')).catch((): Category[] => []),
    fetchJson<LiveStream[]>(apiUrl(playlist, 'action=get_live_streams')).catch((): LiveStream[] => []),
  ])

  const cats = asArray<Category>(catsRaw)
  const streams: LiveStream[] = asArray<LiveStream>(rawStreams)
  const names = new Map<string, string>()
  for (const c of cats) {
    const cid = getCatId(c)
    const cname = getCatName(c)
    if (cid && cname) names.set(cid, cname)
  }

  const presentCatIds = new Set(streams.map((s) => getStreamCatId(s)).filter(Boolean))
  const missingCats = cats.filter((c) => {
    const cid = getCatId(c)
    return cid && (!presentCatIds.has(cid) || isAdultCategoryName(getCatName(c)))
  })

  // Como o Expert: completa categorias faltantes com pouca concorrência (evita 429)
  if (missingCats.length > 0) {
    const existingStreamIds = new Set(streams.map((s) => String(s.stream_id)))
    const extras = await mapPool(missingCats, 2, async (c) => {
      const cid = getCatId(c)
      return asArray<LiveStream>(
        await fetchJson<LiveStream[]>(
          apiUrl(playlist, `action=get_live_streams&category_id=${encodeURIComponent(cid)}`),
        ).catch(() => []),
      )
    })
    for (const batch of extras) {
      for (const item of batch) {
        if (item?.stream_id && !existingStreamIds.has(String(item.stream_id))) {
          existingStreamIds.add(String(item.stream_id))
          streams.push(item)
        }
      }
    }
  }

  return streams.map((s) => {
    const cid = getStreamCatId(s)
    const sname = s.name || ''
    const groupName = names.get(cid) || (isAdultCategoryName(sname) ? 'ADULTOS +18 | CANAIS' : 'Ao vivo')
    return {
      id: `live-${s.stream_id}`,
      name: sname,
      group: groupName,
      url: liveUrl(playlist, s.stream_id),
      logo: absLogo(playlist, s.stream_icon),
      kind: 'live' as const,
      tvgId: s.epg_channel_id,
      streamId: String(s.stream_id),
      categoryId: cid || undefined,
    }
  })
}

/**
 * URL de live ATUAL do mesmo canal, re-consultando o painel.
 *
 * O painel rotaciona stream_id: nesta conta 709056 virou 404 e o mesmo
 * canal passou a responder em 709057/709058. O catalogo guarda a URL
 * montada no load e nunca mais re-resolve, entao abrir um canal que morreu ha
 * dez minutos insistia no ID morto.
 *
 * O casamento (tvg-id, depois nome normalizado) e a trava contra devolver o
 * proprio id estao em live-stream-match.ts, puros e testados. Aqui so
 * falta a parte de rede.
 *
 * @returns o canal com URL nova, ou 
ull se nao mudou / nao achou / falhou
 */
export async function resolveFreshLiveChannel(
  playlist: Playlist,
  channel: Channel,
): Promise<Channel | null> {
  if (!playlist.xtream || channel.kind !== 'live') return null
  const streams = asArray<LiveStream>(
    await fetchJson<LiveStream[]>(apiUrl(playlist, 'action=get_live_streams')).catch(
      (): LiveStream[] => [],
    ),
  )
  if (streams.length === 0) return null
  const match = matchLiveStream(streams, channel)
  if (!match) return null
  return {
    ...channel,
    id: 'live-' + String(match.stream_id),
    url: liveUrl(playlist, match.stream_id),
    streamId: String(match.stream_id),
    tvgId: match.epg_channel_id ?? channel.tvgId,
    logo: absLogo(playlist, match.stream_icon) ?? channel.logo,
  }
}
export type XtreamCategory = { id: string; name: string }

const xtreamM3uCache = new Map<string, Channel[]>()

/** Carrega o M3U completo do painel (método do IPTV Expert). */
export async function loadXtreamFullM3u(playlist: Playlist, force = false): Promise<Channel[]> {
  const cacheKey = playlist.id
  if (!force) {
    const hit = xtreamM3uCache.get(cacheKey)
    if (hit && hit.length > 0) return hit
  }

  let text = ''
  try {
    text = await fetchText(xtreamM3uUrl(playlist, 'ts'))
  } catch {
    text = await fetchText(xtreamM3uUrl(playlist, 'm3u8'))
  }

  if (!text.includes('#EXTINF')) {
    throw new Error('Playlist M3U vazia ou inválida')
  }

  const items = parseM3u(text)
  if (items.length > 0) xtreamM3uCache.set(cacheKey, items)
  return items
}

export function clearXtreamM3uCache(playlistId?: string) {
  if (playlistId) xtreamM3uCache.delete(playlistId)
  else xtreamM3uCache.clear()
}

/** Anexa "(2026)" ao nome se o painel mandou o ano em outro campo (estilo TiviMate). */
function appendReleaseYearToName(name: string, release?: string): string {
  const base = String(name || '').trim()
  if (!base) return base
  if (/\(\s*(?:19|20)\d{2}\s*\)/.test(base)) return base
  if (!release) return base
  const match = String(release).match(/\b((?:19|20)\d{2})\b/)
  if (!match) return base
  const year = Number(match[1])
  if (year < 1900 || year > 2100) return base
  return `${base} (${match[1]})`
}

function mapVodToChannel(playlist: Playlist, s: VodStream, groupName: string, categoryId?: string): Channel {
  const cid = categoryId || getStreamCatId(s)
  const releasedate = pickStreamReleaseDate(s)
  return {
    id: `vod-${s.stream_id}`,
    name: appendReleaseYearToName(s.name || '', releasedate),
    group: groupName,
    url: vodUrl(playlist, s.stream_id, s.container_extension || 'mp4'),
    logo: absLogo(playlist, s.stream_icon || s.movie_image || s.cover_big || s.cover),
    kind: 'movie',
    streamId: String(s.stream_id),
    categoryId: cid || undefined,
    extension: s.container_extension,
    plot: pickPlot(s),
    added: s.added,
    releasedate,
    rating: s.rating !== undefined && s.rating !== null ? String(s.rating) : undefined,
  }
}

function mapSeriesToChannel(playlist: Playlist, s: SeriesItem, groupName: string, categoryId?: string): Channel {
  const cid = categoryId || getStreamCatId(s)
  const releasedate = pickStreamReleaseDate(s)
  return {
    id: `series-${s.series_id}`,
    name: appendReleaseYearToName(s.name || '', releasedate),
    group: groupName,
    url: String(s.series_id),
    logo: absLogo(playlist, s.cover),
    kind: 'series',
    streamId: String(s.series_id),
    categoryId: cid || undefined,
    plot: pickPlot(s),
    added: s.last_modified,
    releasedate,
    rating: s.rating !== undefined && s.rating !== null ? String(s.rating) : undefined,
  }
}

async function fetchWithRetry<T>(url: string, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson<T>(url)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 350 * (i + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Falha na API')
}

export async function loadXtreamVodCategories(playlist: Playlist): Promise<XtreamCategory[]> {
  const cats = asArray<Category>(
    await fetchWithRetry<Category[]>(apiUrl(playlist, 'action=get_vod_categories')).catch(() => []),
  )
  const out: XtreamCategory[] = []
  const seen = new Set<string>()
  for (const c of cats) {
    const id = getCatId(c)
    const name = getCatName(c)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

/** Categorias de filmes esperadas no painel (TV). Soft-match evita duplicar as que a API já mandou. */
const EXPECTED_MOVIE_CATEGORY_NAMES = [
  'ESPECIAL DE NATAL',
  'OSCAR 2026',
  'UHD | 4K',
  'CINEMA',
  'LANÇAMENTOS',
  'CINE NOSTALGIA',
  'ESPECIAL CHUCK NORRIS',
  'AÇÃO',
  'CRIME',
  'TERROR',
  'SUSPENSE',
  'DRAMA',
  'GUERRA',
  'FAROESTE',
  'ESPECIAL INFANTIL',
  'ANIMAÇÃO',
  'AVENTURA',
  'FANTASIA',
  'FICÇÃO',
  'MARVEL | DC',
  'COMEDIA',
  'ROMANCE',
  'FAMILIA',
  'DOCUMENTARIOS',
  'RELIGIOSOS',
  'ESPORTES',
  'NACIONAIS',
  'SHOWS',
  'SHOWS GOSPEL',
  "SHOWS ROCK'IN RIO 2022",
  "SHOWS ROCK'IN RIO 2024",
  "FLASHBACK'S - 70, 80, 90",
  'STAND UP',
  'DUBLAGEM NÃO OFICIAL',
  'LEGENDADOS',
  'DIVERSOS',
  'ADULTOS XXX',
] as const

function normCat(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Une categorias da API com a lista do servidor — só nomes reais da API (sem shells vazios). */
export function mergeMovieCategoryList(apiCats: XtreamCategory[]): XtreamCategory[] {
  if (apiCats.length === 0) return []

  const softSame = (a: string, b: string) => {
    if (a === b) return true
    const stripYear = (s: string) => s.replace(/\b20\d{2}\b/g, '').replace(/\s+/g, ' ').trim()
    if (stripYear(a) && stripYear(a) === stripYear(b)) return true
    if (a.replace(/S$/, '') === b.replace(/S$/, '')) return true
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (short.length >= 4 && (` ${long} `).includes(` ${short} `)) return true
    return false
  }

  const byNorm = new Map<string, XtreamCategory>()
  for (const cat of apiCats) {
    const n = normCat(cat.name)
    if (!n || byNorm.has(n)) continue
    byNorm.set(n, cat)
  }

  const out: XtreamCategory[] = []
  const used = new Set<string>()

  // Ordena como na TV quando o nome da API bate com a lista esperada
  for (const expected of EXPECTED_MOVIE_CATEGORY_NAMES) {
    const en = normCat(expected)
    let hit: XtreamCategory | undefined
    for (const [n, cat] of byNorm) {
      if (used.has(cat.id)) continue
      if (softSame(n, en)) {
        hit = cat
        break
      }
    }
    if (hit) {
      used.add(hit.id)
      out.push(hit)
    }
  }

  for (const cat of apiCats) {
    if (used.has(cat.id)) continue
    used.add(cat.id)
    out.push(cat)
  }

  return out
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Expert: o endpoint por category_id devolve a lista daquela cat.
 * Só filtra se vier dump misturado com outros category_id.
 */
function filterVodByCategory(items: VodStream[], categoryId: string): VodStream[] {
  if (items.length === 0) return []
  const matched = items.filter((s) => getStreamCatId(s) === categoryId)
  if (matched.length > 0) return matched

  const foreign = items.filter((s) => {
    const cid = getStreamCatId(s)
    return cid && cid !== categoryId
  })
  // Dump global disfarçado — só descarta se for claramente misturado e enorme
  if (foreign.length > items.length * 0.85 && items.length > 4000) return []

  // Sem tags ou tags vazias → confiar no endpoint (como o Expert / TiviMate)
  return items
}

export async function loadXtreamVodCategory(
  playlist: Playlist,
  categoryId: string,
  categoryName: string,
): Promise<Channel[]> {
  if (!categoryId || categoryId.startsWith('movie-cat:')) return []

  const url = apiUrl(playlist, `action=get_vod_streams&category_id=${encodeURIComponent(categoryId)}`)
  let raw: VodStream[] = []
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      raw = asArray<VodStream>(await fetchJson<VodStream[]>(url))
      break
    } catch (error) {
      // Sessão expirada é permanente: repetir só queima 18s de backoff por
      // categoria (e o loadXtreamVod ainda refaz por categoria) para terminar
      // com a mesma grade vazia. Deixa o erro subir.
      if (isAuthExpired(error)) throw error
      await delay(1200 * (attempt + 1))
    }
  }

  const items = filterVodByCategory(raw, categoryId)
  return items
    .filter((s) => s?.stream_id)
    .map((s) => mapVodToChannel(playlist, { ...s, category_id: categoryId }, categoryName, categoryId))
}

/**
 * FILMES: dump global (rápido) + um get_vod_streams por categoria.
 * O painel corta o dump único (~21k de ~30k). Sem o fill, categorias
 * como CINEMA só aparecem cheias depois que o usuário clica nelas.
 */
export async function loadXtreamVod(
  playlist: Playlist,
  onProgress?: (items: Channel[]) => void,
): Promise<Channel[]> {
  let apiCats = await loadXtreamVodCategories(playlist)
  if (apiCats.length === 0) {
    await delay(1500)
    apiCats = await loadXtreamVodCategories(playlist)
  }

  const names = new Map<string, string>()
  for (const cat of apiCats) names.set(String(cat.id), cat.name)

  const byId = new Map<string, Channel>()
  const emit = () => onProgress?.([...byId.values()])

  const ingest = (streams: VodStream[]) => {
    for (const s of streams) {
      if (!s?.stream_id || !String(s.name || '').trim()) continue
      const cid = getStreamCatId(s)
      const group =
        (cid && names.get(cid)) ||
        (isAdultCategoryName(s.name || '') ? 'ADULTOS XXX' : 'Filmes')
      byId.set(`vod-${s.stream_id}`, mapVodToChannel(playlist, s, group, cid || undefined))
    }
    emit()
  }

  // Player One: adempausa + um dump global (não dispara dezenas de category_id)
  await delay(300)
  const vodUrlAll = apiUrl(playlist, 'action=get_vod_streams')
  try {
    let streams = asArray<VodStream>(
      await fetchJson<VodStream[]>(vodUrlAll, { timeoutMs: PANEL_LARGE_TIMEOUT_MS }),
    )
    if (streams.length === 0) {
      await delay(3000)
      streams = asArray<VodStream>(
        await fetchJson<VodStream[]>(vodUrlAll, { timeoutMs: PANEL_LARGE_TIMEOUT_MS }),
      )
    }
    ingest(streams)
  } catch {
    // cai no fill por categoria
  }

  if (apiCats.length === 0) {
    return [...byId.values()]
  }

  // Sempre completa por category_id — o dump global deste painel não traz tudo
  const failed: XtreamCategory[] = []
  const concurrency = 2
  for (let i = 0; i < apiCats.length; i += concurrency) {
    const slice = apiCats.slice(i, i + concurrency)
    if (i > 0) await delay(i % 18 === 0 ? 900 : 280)
    const batches = await Promise.all(
      slice.map(async (cat) => {
        let batch = await loadXtreamVodCategory(playlist, cat.id, cat.name)
        if (batch.length === 0) {
          await delay(800)
          batch = await loadXtreamVodCategory(playlist, cat.id, cat.name)
        }
        return [cat, batch] as const
      }),
    )
    for (const [cat, batch] of batches) {
      if (batch.length === 0) {
        failed.push(cat)
        continue
      }
      for (const item of batch) byId.set(item.id, item)
    }
    emit()
  }

  for (const cat of failed) {
    await delay(1400)
    const batch = await loadXtreamVodCategory(playlist, cat.id, cat.name)
    if (batch.length === 0) continue
    for (const item of batch) byId.set(item.id, item)
    emit()
  }

  return [...byId.values()]
}

export async function loadXtreamSeriesCategories(playlist: Playlist): Promise<XtreamCategory[]> {
  const cats = asArray<Category>(
    await fetchWithRetry<Category[]>(apiUrl(playlist, 'action=get_series_categories')).catch(() => []),
  )
  const out: XtreamCategory[] = []
  const seen = new Set<string>()
  for (const c of cats) {
    const id = getCatId(c)
    const name = getCatName(c)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

function filterSeriesByCategory(items: SeriesItem[], categoryId: string): SeriesItem[] {
  if (items.length === 0) return []
  const matched = items.filter((s) => getStreamCatId(s) === categoryId)
  if (matched.length > 0) return matched

  const foreign = items.filter((s) => {
    const cid = getStreamCatId(s)
    return cid && cid !== categoryId
  })
  if (foreign.length > items.length * 0.85 && items.length > 4000) return []

  return items
}

export async function loadXtreamSeriesCategory(
  playlist: Playlist,
  categoryId: string,
  categoryName: string,
): Promise<Channel[]> {
  const url = apiUrl(playlist, `action=get_series&category_id=${encodeURIComponent(categoryId)}`)
  // `asArray` fica FORA do `.catch(() => [])`: a rejeição de sessão expirada
  // antes derrubava o Promise.all de loadXtreamSeries, abortando o catálogo
  // inteiro de séries por causa de UMA categoria ruim. O `.catch` estava
  // ligado ao `fetchWithRetry` e engolia o erro do `asArray`.
  let items = asArray<SeriesItem>(await fetchWithRetry<SeriesItem[]>(url).catch(() => []))
  if (items.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    items = asArray<SeriesItem>(await fetchWithRetry<SeriesItem[]>(url).catch(() => []))
  }
  // Se veio dump misturado, filtra pelo id
  const use = filterSeriesByCategory(items, categoryId)
  return use
    .filter((s) => s?.series_id)
    .map((s) => mapSeriesToChannel(playlist, { ...s, category_id: categoryId }, categoryName, categoryId))
}

export async function loadXtreamSeries(
  playlist: Playlist,
  onProgress?: (items: Channel[]) => void,
): Promise<Channel[]> {
  const cats = await loadXtreamSeriesCategories(playlist)
  const names = new Map<string, string>()
  for (const cat of cats) names.set(String(cat.id), cat.name)

  const byId = new Map<string, Channel>()
  const emit = () => onProgress?.([...byId.values()])

  const ingest = (streams: SeriesItem[]) => {
    for (const s of streams) {
      if (!s?.series_id || !String(s.name || '').trim()) continue
      const cid = getStreamCatId(s)
      const group =
        (cid && names.get(cid)) ||
        (isAdultCategoryName(s.name || '') ? 'ADULTOS XXX' : 'Séries')
      byId.set(`series-${s.series_id}`, mapSeriesToChannel(playlist, s, group, cid || undefined))
    }
    emit()
  }

  if (cats.length === 0) {
    const globalSeries = asArray<SeriesItem>(
      await fetchWithRetry<SeriesItem[]>(apiUrl(playlist, 'action=get_series')).catch(() => []),
    )
    ingest(globalSeries)
    return [...byId.values()]
  }

  await delay(300)
  try {
    let streams = asArray<SeriesItem>(
      await fetchJson<SeriesItem[]>(apiUrl(playlist, 'action=get_series'), { timeoutMs: PANEL_LARGE_TIMEOUT_MS }),
    )
    if (streams.length === 0) {
      await delay(2000)
      streams = asArray<SeriesItem>(
        await fetchJson<SeriesItem[]>(apiUrl(playlist, 'action=get_series'), { timeoutMs: PANEL_LARGE_TIMEOUT_MS }),
      )
    }
    ingest(streams)
  } catch {
    // completa por categoria
  }

  const failed: XtreamCategory[] = []
  const concurrency = 2
  for (let i = 0; i < cats.length; i += concurrency) {
    const slice = cats.slice(i, i + concurrency)
    if (i > 0) await delay(i % 18 === 0 ? 900 : 280)
    const batches = await Promise.all(
      slice.map(async (cat) => {
        let batch = await loadXtreamSeriesCategory(playlist, cat.id, cat.name)
        if (batch.length === 0) {
          await delay(800)
          batch = await loadXtreamSeriesCategory(playlist, cat.id, cat.name)
        }
        return [cat, batch] as const
      }),
    )
    for (const [cat, batch] of batches) {
      if (batch.length === 0) {
        failed.push(cat)
        continue
      }
      for (const item of batch) byId.set(item.id, item)
    }
    emit()
  }

  for (const cat of failed) {
    await delay(1400)
    const batch = await loadXtreamSeriesCategory(playlist, cat.id, cat.name)
    if (batch.length === 0) continue
    for (const item of batch) byId.set(item.id, item)
    emit()
  }

  return [...byId.values()]
}

function formatEpisodeDuration(val?: string | number): string | undefined {
  if (val === undefined || val === null || val === '') return undefined
  if (typeof val === 'string') {
    const trimmed = val.trim()
    const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
    if (timeMatch) {
      const h = parseInt(timeMatch[1], 10)
      const m = parseInt(timeMatch[2], 10)
      const totalMins = h * 60 + m
      return `${totalMins} minutos`
    }
    const num = Number(trimmed)
    if (!isNaN(num) && num > 0) {
      return num > 500 ? `${Math.round(num / 60)} minutos` : `${Math.round(num)} minutos`
    }
    return trimmed
  }
  if (typeof val === 'number' && val > 0) {
    return val > 500 ? `${Math.round(val / 60)} minutos` : `${Math.round(val)} minutos`
  }
  return undefined
}

export function peekLoadedSeriesInfo(playlist: Playlist, seriesId: string): SeriesInfo | undefined {
  const cached = peekSeriesInfoCache(seriesInfoCacheKey(playlist.id, seriesId))
  return cached as SeriesInfo | undefined
}

/** Dispara get_series_info em fundo (hover na grelha) para o clique já ter cache. */
export function prefetchSeriesInfo(playlist: Playlist, seriesId: string) {
  if (!seriesId) return
  if (peekLoadedSeriesInfo(playlist, seriesId)) return
  void loadSeriesInfo(playlist, seriesId)
}

export async function loadSeriesInfo(playlist: Playlist, seriesId: string): Promise<SeriesInfo> {
  type EpisodeInfo = {
    name?: string
    title?: string
    plot?: string
    description?: string
    overview?: string
    releasedate?: string
    release_date?: string
    air_date?: string
    duration?: string | number
    duration_secs?: string | number
    movie_image?: string
    still_path?: string
    cover?: string
    cover_big?: string
    rating?: string | number
  }

  type Episode = {
    id: string | number
    title?: string
    container_extension?: string
    season?: number
    episode_num?: number | string
    info?: EpisodeInfo
    plot?: string
    overview?: string
    releasedate?: string
    release_date?: string
    duration?: string | number
    duration_secs?: string | number
    movie_image?: string
    cover?: string
  }

  type SeriesData = {
    info?: {
      name?: string
      cover?: string
      plot?: string
      description?: string
      overview?: string
      cast?: string
      director?: string
      genre?: string
      releaseDate?: string
      rating?: string | number
      last_modified?: string | number
      added?: string | number
    }
    episodes?: Record<string, Episode[]>
  }

  const key = seriesInfoCacheKey(playlist.id, seriesId)
  const cached = peekSeriesInfoCache(key) as SeriesInfo | undefined
  if (cached) return cached

  return coalesceSeriesInfoLoad(key, async () => {
    const again = peekSeriesInfoCache(key) as SeriesInfo | undefined
    if (again) return again

    const data = await fetchJson<SeriesData>(
      apiUrl(playlist, `action=get_series_info&series_id=${seriesId}`),
      { priority: true },
    )

    const seasons = Object.entries(data.episodes ?? {}).map(([season, episodes]) => ({
      season: Number(season),
      episodes: (Array.isArray(episodes) ? episodes : []).map((ep) => {
        const epInfo = ep.info || {}
        const epId = String(ep.id)
        const plot = pickPlot(ep, epInfo) || ''
        const releaseDate =
          epInfo.releasedate ||
          epInfo.release_date ||
          epInfo.air_date ||
          ep.releasedate ||
          ep.release_date ||
          ''
        const rawDur =
          epInfo.duration_secs ||
          ep.duration_secs ||
          epInfo.duration ||
          ep.duration
        const duration = formatEpisodeDuration(rawDur)
        const rawImg =
          epInfo.movie_image ||
          ep.movie_image ||
          epInfo.still_path ||
          (ep as { still_path?: string }).still_path ||
          epInfo.cover ||
          ep.cover ||
          epInfo.cover_big
        const logo = rawImg ? absLogo(playlist, rawImg) : undefined

        return {
          id: `ep-${epId}`,
          name: ep.title || epInfo.name || epInfo.title || `Episódio ${ep.episode_num ?? epId}`,
          group: `Temporada ${season}`,
          url: seriesUrl(playlist, epId, ep.container_extension || 'mp4'),
          logo,
          kind: 'series' as const,
          streamId: epId,
          seriesId: String(seriesId),
          extension: ep.container_extension,
          plot: plot ? String(plot) : undefined,
          duration,
          releasedate: releaseDate ? String(releaseDate) : undefined,
        }
      }),
    }))

    const addedDate = formatAddedDate(
      data.info?.last_modified || data.info?.added || (data as any).last_modified || (data as any).added
    )

    const infoRecord = coerceRecord(data.info)
    const seriesPlot = pickPlot(infoRecord, data)
    const result: SeriesInfo = {
      seasons,
      info: data.info ? { ...data.info, plot: seriesPlot || data.info.plot, addedDate } : undefined,
    }
    setSeriesInfoCache(key, result)

    if (!seriesPlot) {
      void fetchItunesPlot(
        String(infoRecord?.name || ''),
        String(infoRecord?.releaseDate || infoRecord?.releasedate || ''),
        'tvShow',
      ).then((plot) => {
        if (!plot) return
        const prev = peekSeriesInfoCache(key) as SeriesInfo | undefined
        if (!prev) return
        setSeriesInfoCache(key, {
          ...prev,
          info: { ...prev.info, plot },
        })
      })
    }

    return result
  })
}

export function formatAddedDate(val?: string | number): string | undefined {
  if (!val) return undefined
  const num = Number(val)
  if (!isNaN(num) && num > 100000000) {
    const d = new Date(num * 1000)
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0')
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const year = d.getFullYear()
      return `${day}/${month}/${year}`
    }
  }
  if (typeof val === 'string' && val.includes('-')) {
    const parts = val.split(' ')[0].split('-')
    if (parts.length === 3) {
      return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`
    }
  }
  return String(val)
}

export async function loadVodInfo(playlist: Playlist, vodId: string): Promise<ContentDetails> {
  const key = vodInfoCacheKey(playlist.id, vodId)
  const cached = peekVodInfoCache(key) as ContentDetails | undefined
  if (cached) return cached

  return coalesceVodInfoLoad(key, async () => {
    const data = await fetchJson<Record<string, unknown>>(
      apiUrl(playlist, `action=get_vod_info&vod_id=${encodeURIComponent(vodId)}`),
      { priority: true, timeoutMs: 30_000 },
    )

    const info = coerceRecord(data.info) || {}
    const movieData = coerceRecord(data.movie_data) || coerceRecord(data.movieData) || {}
    const str = (...keys: string[]) => {
      for (const rec of [info, movieData]) {
        for (const key of keys) {
          const value = rec[key]
          if (value === undefined || value === null || value === '') continue
          if (typeof value === 'object') continue
          const text = String(value).trim()
          if (text) return text
        }
      }
      return undefined
    }

    const rawAdded = movieData.added ?? info.added
    const addedDate = formatAddedDate(rawAdded as string | number | undefined)

    const rawDur = info.duration_secs ?? info.duration ?? info.episode_run_time
    const duration =
      formatEpisodeDuration(rawDur as string | number | undefined) ||
      (info.duration ? String(info.duration) : undefined)

    const backdrop = info.backdrop_path
    const backdropFirst = Array.isArray(backdrop) ? backdrop[0] : undefined
    const rawImg =
      str('movie_image', 'cover_big', 'cover') ||
      (typeof backdropFirst === 'string' ? backdropFirst : undefined)

    const title = str('name', 'o_name', 'title')
    const releasedate = str('releasedate', 'release_date', 'year')
    const plot = pickPlot(info, movieData, data)

    const result: ContentDetails = {
      name: title,
      plot,
      duration,
      releasedate,
      addedDate,
      rating: info.rating !== undefined && info.rating !== null ? String(info.rating) : undefined,
      cast: str('cast', 'actors'),
      director: str('director'),
      genre: str('genre'),
      cover: rawImg ? absLogo(playlist, rawImg) : undefined,
    }
    setVodInfoCache(key, result)

    if (!plot) {
      void fetchItunesPlot(title || '', releasedate, 'movie').then((itunesPlot) => {
        if (!itunesPlot) return
        const prev = peekVodInfoCache(key) as ContentDetails | undefined
        if (!prev) return
        setVodInfoCache(key, { ...prev, plot: itunesPlot })
      })
    }

    return result
  })
}

export async function loadShortEpg(playlist: Playlist, streamId: string): Promise<ShortEpg | null> {
  const rows = await loadShortEpgList(playlist, streamId, 1)
  return rows[0] ?? null
}

type EpgApiRow = {
  title?: string
  start?: string
  end?: string
  description?: string
  start_timestamp?: string | number
  stop_timestamp?: string | number
}

function mapEpgApiRows(rows: EpgApiRow[] | undefined): ShortEpg[] {
  if (!rows?.length) return []
  return rows
    .filter((row) => row?.title || row?.description)
    .map((row) => ({
      title: String(row.title || ''),
      start: row.start || (row.start_timestamp != null ? String(row.start_timestamp) : undefined),
      end: row.end || (row.stop_timestamp != null ? String(row.stop_timestamp) : undefined),
      description: row.description,
    }))
}

export async function loadShortEpgList(
  playlist: Playlist,
  streamId: string,
  limit = 4,
): Promise<ShortEpg[]> {
  const data = await fetchJson<EpgApiRow[] | { epg_listings?: EpgApiRow[] }>(
    apiUrl(playlist, `action=get_short_epg&stream_id=${encodeURIComponent(streamId)}&limit=${Math.max(1, Math.min(limit, 40))}`),
  )
  const rows = Array.isArray(data) ? data : data.epg_listings
  return mapEpgApiRows(rows)
}

/** Guia completo do canal (dia inteiro) — melhor que get_short_epg no Programação. */
export async function loadEpgDataTable(playlist: Playlist, streamId: string): Promise<ShortEpg[]> {
  const data = await fetchJson<EpgApiRow[] | { epg_listings?: EpgApiRow[] }>(
    apiUrl(playlist, `action=get_simple_data_table&stream_id=${encodeURIComponent(streamId)}`),
    { timeoutMs: 20_000 },
  )
  const rows = Array.isArray(data) ? data : data.epg_listings
  const mapped = mapEpgApiRows(rows)
  if (mapped.length > 0) return mapped
  // Alguns painéis só respondem no short_epg
  return loadShortEpgList(playlist, streamId, 40)
}
