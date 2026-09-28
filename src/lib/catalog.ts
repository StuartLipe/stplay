import type { Channel, ContentKind, Playlist } from '../types'
import { parseM3u } from './m3u'
import { fetchText } from './proxy'
import { clearDiskCatalog, loadDiskCatalog, saveDiskCatalog } from './catalogDisk'
import {
  clearXtreamM3uCache,
  loadXtreamFullM3u,
  loadXtreamLive,
  loadXtreamSeries,
  loadXtreamSeriesCategories,
  loadXtreamSeriesCategory,
  loadXtreamVod,
  loadXtreamVodCategories,
  loadXtreamVodCategory,
  mergeMovieCategoryList,
  toXtreamPlaylist,
  type XtreamCategory,
} from './xtream'

export type { XtreamCategory }

const byKind = new Map<string, Channel[]>()
const categoriesByKind = new Map<string, XtreamCategory[]>()
const byCategory = new Map<string, Channel[]>()
const m3uAll = new Map<string, Channel[]>()

function key(playlistId: string, kind: ContentKind) {
  return `${playlistId}:${kind}`
}

function catKey(playlistId: string, kind: ContentKind, categoryId: string) {
  return `${playlistId}:${kind}:cat:${categoryId}`
}

function mergeChannels(existing: Channel[], incoming: Channel[]) {
  const map = new Map<string, Channel>()
  for (const item of existing) map.set(item.id, item)
  for (const item of incoming) map.set(item.id, item)
  return [...map.values()]
}

function categoriesFromChannels(items: Channel[]): XtreamCategory[] {
  const seen = new Set<string>()
  const cats: XtreamCategory[] = []
  for (const item of items) {
    if (!item.group || seen.has(item.group)) continue
    seen.add(item.group)
    cats.push({ id: item.group, name: item.group })
  }
  return cats
}

async function loadM3uPlaylist(playlist: Playlist) {
  const hit = m3uAll.get(playlist.id)
  if (hit) return hit
  const items = parseM3u(playlist.m3uText ?? (await fetchText(playlist.m3uUrl!)))
  m3uAll.set(playlist.id, items)
  return items
}

type ProgressCb = (items: Channel[]) => void

/** SÉRIES — API Xtream como o Expert (M3U com user/pass também). */
async function loadSeriesCatalog(playlist: Playlist, onProgress?: ProgressCb): Promise<Channel[]> {
  const cacheKey = key(playlist.id, 'series')
  const xtream = toXtreamPlaylist(playlist)

  if (xtream) {
    const cats = await loadXtreamSeriesCategories(xtream).catch(() => [] as XtreamCategory[])
    if (cats.length > 0) categoriesByKind.set(cacheKey, cats)

    const items = await loadXtreamSeries(xtream, (partial) => {
      byKind.set(cacheKey, partial)
      onProgress?.(partial)
    })
    if (items.length > 0) {
      byKind.set(cacheKey, items)
      if (cats.length === 0) {
        categoriesByKind.set(cacheKey, categoriesFromChannels(items))
      }
      for (const cat of cats.length ? cats : categoriesFromChannels(items)) {
        const batch = items.filter(
          (item) => item.group === cat.name || item.categoryId === cat.id,
        )
        if (batch.length > 0) byCategory.set(catKey(playlist.id, 'series', cat.id), batch)
      }
    }
    return items
  }

  if (playlist.kind === 'm3u') {
    const all = await loadM3uPlaylist(playlist)
    const items = groupM3uSeriesEpisodes(all.filter((item) => item.kind === 'series'))
    if (items.length > 0) {
      byKind.set(cacheKey, items)
      categoriesByKind.set(cacheKey, categoriesFromChannels(items))
    }
    return items
  }

  return []
}

/** FILMES — API Xtream por categoria (M3U trunca ~3k). */
async function loadMovieCatalog(
  playlist: Playlist,
  force = false,
  onProgress?: ProgressCb,
): Promise<Channel[]> {
  const cacheKey = key(playlist.id, 'movie')
  const xtream = toXtreamPlaylist(playlist)

  if (xtream) {
    const apiCats = await loadXtreamVodCategories(xtream).catch(() => [] as XtreamCategory[])
    const cats = mergeMovieCategoryList(apiCats)
    if (cats.length > 0) categoriesByKind.set(cacheKey, cats)

    try {
      const items = await loadXtreamVod(xtream, (partial) => {
        byKind.set(cacheKey, partial)
        onProgress?.(partial)
      })
      if (items.length > 0) {
        byKind.set(cacheKey, items)
        if (cats.length === 0) {
          categoriesByKind.set(cacheKey, mergeMovieCategoryList(categoriesFromChannels(items)))
        }
        for (const cat of cats) {
          const batch = items.filter(
            (item) => item.group === cat.name || (item.categoryId && item.categoryId === cat.id),
          )
          if (batch.length > 0) byCategory.set(catKey(playlist.id, 'movie', cat.id), batch)
        }
        onProgress?.(items)
        return items
      }
    } catch {
      // fallback M3U
    }

    try {
      const all = await loadXtreamFullM3u(xtream, force)
      const items = all.filter((item) => item.kind === 'movie')
      if (items.length > 0) {
        byKind.set(cacheKey, items)
        if (!categoriesByKind.get(cacheKey)?.length) {
          categoriesByKind.set(cacheKey, mergeMovieCategoryList(categoriesFromChannels(items)))
        }
        onProgress?.(items)
        return items
      }
    } catch {
      // vazio
    }

    return byKind.get(cacheKey) ?? []
  }

  // M3U puro (sem credenciais Xtream)
  const all = await loadM3uPlaylist(playlist)
  const items = all.filter((item) => item.kind === 'movie')
  if (items.length > 0) {
    byKind.set(cacheKey, items)
    categoriesByKind.set(cacheKey, mergeMovieCategoryList(categoriesFromChannels(items)))
  }
  return items
}

async function loadLiveCatalog(playlist: Playlist, force = false): Promise<Channel[]> {
  const cacheKey = key(playlist.id, 'live')

  if (playlist.kind === 'xtream') {
    // API primeiro — M3U get.php com 30k filmes demora e estoura rate limit
    try {
      const items = await loadXtreamLive(playlist)
      if (items.length > 0) {
        byKind.set(cacheKey, items)
        return items
      }
    } catch {
      // M3U fallback
    }
    try {
      const all = await loadXtreamFullM3u(playlist, force)
      const items = all.filter((item) => item.kind === 'live')
      if (items.length > 0) {
        byKind.set(cacheKey, items)
        return items
      }
    } catch {
      // vazio
    }
    return byKind.get(cacheKey) ?? []
  }

  const all = await loadM3uPlaylist(playlist)
  const items = all.filter((item) => item.kind === 'live')
  if (items.length > 0) byKind.set(cacheKey, items)
  return items
}

export async function loadCategories(playlist: Playlist, kind: ContentKind): Promise<XtreamCategory[]> {
  if (kind === 'live') return []
  const cacheKey = key(playlist.id, kind)
  const cached = categoriesByKind.get(cacheKey)
  if (cached && cached.length > 0) return cached

  // FILMES: categorias da API imediatamente
  if (kind === 'movie') {
    const xtream = toXtreamPlaylist(playlist)
    if (xtream) {
      const apiCats = await loadXtreamVodCategories(xtream).catch(() => [] as XtreamCategory[])
      const cats = mergeMovieCategoryList(apiCats)
      if (cats.length > 0) {
        categoriesByKind.set(cacheKey, cats)
        return cats
      }
    }
    const items = await loadCatalog(playlist, 'movie')
    const cats = mergeMovieCategoryList(categoriesByKind.get(cacheKey) ?? categoriesFromChannels(items))
    categoriesByKind.set(cacheKey, cats)
    return cats
  }

  // SÉRIES: isolado — só o que o carregamento de séries já gravou
  const items = await loadCatalog(playlist, 'series')
  const cats = categoriesByKind.get(cacheKey) ?? categoriesFromChannels(items)
  categoriesByKind.set(cacheKey, cats)
  return cats
}

function matchesCategory(item: Channel, category: XtreamCategory) {
  return (
    item.group === category.name ||
    item.group === category.id ||
    (item.categoryId !== undefined && String(item.categoryId) === String(category.id))
  )
}

export async function loadCategoryContent(
  playlist: Playlist,
  kind: 'movie' | 'series',
  category: XtreamCategory,
  force = false,
): Promise<Channel[]> {
  const cacheKey = catKey(playlist.id, kind, category.id)
  if (!force) {
    const hit = byCategory.get(cacheKey)
    if (hit && hit.length > 0) return hit
  }

  // ——— SÉRIES ———
  if (kind === 'series') {
    const all = byKind.get(key(playlist.id, 'series'))
    if (all && all.length > 0) {
      const items = all.filter((item) => matchesCategory(item, category))
      if (items.length > 0) {
        byCategory.set(cacheKey, items)
        return items
      }
    }
    const xtream = toXtreamPlaylist(playlist)
    if (xtream && category.id) {
      const items = await loadXtreamSeriesCategory(xtream, category.id, category.name)
      if (items.length > 0) {
        byCategory.set(cacheKey, items)
        byKind.set(
          key(playlist.id, 'series'),
          mergeChannels(byKind.get(key(playlist.id, 'series')) ?? [], items),
        )
      }
      return items
    }
    const loaded = await loadCatalog(playlist, 'series')
    return loaded.filter((item) => matchesCategory(item, category))
  }

  // ——— FILMES ———
  const xtream = toXtreamPlaylist(playlist)
  if (xtream && category.id) {
    try {
      const items = await loadXtreamVodCategory(xtream, category.id, category.name)
      if (items.length > 0) {
        byCategory.set(cacheKey, items)
        byKind.set(key(playlist.id, 'movie'), mergeChannels(byKind.get(key(playlist.id, 'movie')) ?? [], items))
        return items
      }
    } catch {
      // filtro local
    }
  }

  const all = byKind.get(key(playlist.id, 'movie'))
  if (all && all.length > 0) {
    const items = all.filter((item) => matchesCategory(item, category))
    if (items.length > 0) {
      byCategory.set(cacheKey, items)
      return items
    }
  }

  const loaded = await loadCatalog(playlist, 'movie')
  const fromFull = loaded.filter((item) => matchesCategory(item, category))
  if (fromFull.length > 0) {
    byCategory.set(cacheKey, fromFull)
    return fromFull
  }
  return []
}

export async function loadCatalog(
  playlist: Playlist,
  kind: ContentKind,
  force = false,
  onProgress?: ProgressCb,
) {
  const cacheKey = key(playlist.id, kind)

  if (kind === 'series') {
    if (!force) {
      const cached = byKind.get(cacheKey)
      if (cached && cached.length > 0) {
        const groups = new Set(cached.map((c) => c.group).filter(Boolean))
        const xtream = toXtreamPlaylist(playlist)
        const cats = categoriesByKind.get(cacheKey)
        const catCount = cats?.length ?? 0
        const looksTruncated = Boolean(xtream && catCount > 5 && cached.length < 9000)
        // Cache corrompido (tudo numa categoria) → recarrega no caminho isolado de séries
        if (groups.size <= 2 && cached.length > 2000) {
          byKind.delete(cacheKey)
          categoriesByKind.delete(cacheKey)
          for (const k of [...byCategory.keys()]) {
            if (k.startsWith(`${playlist.id}:series:`)) byCategory.delete(k)
          }
        } else if (!looksTruncated) {
          return cached
        }
      }
    }
    return loadSeriesCatalog(playlist, onProgress)
  }

  if (!force) {
    const cached = byKind.get(cacheKey)
    if (cached && cached.length > 0) {
      if (kind === 'movie') {
        const xtream = toXtreamPlaylist(playlist)
        const cats = categoriesByKind.get(cacheKey)
        const catCount = cats?.length ?? 0
        // Painel verde/rosa ~30.6k filmes. Cache de ~21k ainda está truncado.
        const looksTruncated = Boolean(xtream && catCount > 8 && cached.length < 40_000)
        if (!looksTruncated) return cached
      } else {
        return cached
      }
    }
  }

  if (kind === 'movie') return loadMovieCatalog(playlist, force, onProgress)
  return loadLiveCatalog(playlist, force)
}

/** Agrupa episódios SxxExx do M3U em um único card de série (playlist M3U pura). */
function groupM3uSeriesEpisodes(episodes: Channel[]): Channel[] {
  const groups = new Map<string, Channel>()
  for (const ep of episodes) {
    const baseName = ep.name
      .replace(/\bS\d{1,2}\s*E\d{1,3}\b/gi, '')
      .replace(/\b\d{1,2}x\d{1,3}\b/gi, '')
      .replace(/\bE(P|pisódio)?\s*\d+\b/gi, '')
      .replace(/\s*[-–—|]\s*$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || ep.name
    const keyName = `${ep.group}::${baseName}`.toLowerCase()
    if (!groups.has(keyName)) {
      groups.set(keyName, {
        ...ep,
        id: `series-m3u-${keyName}`,
        name: baseName,
        url: ep.seriesId || ep.streamId || ep.url,
        seriesId: ep.streamId,
        seriesName: baseName,
        seriesLogo: ep.logo,
      })
    }
  }
  return [...groups.values()]
}

export function cachedCount(playlistId: string, kind: ContentKind) {
  return byKind.get(key(playlistId, kind))?.length ?? 0
}

/** Hidrata memória a partir do disco (abertura rápida). */
export async function hydrateCatalogFromDisk(
  playlistId: string,
  kind: ContentKind,
): Promise<Channel[]> {
  const mem = byKind.get(key(playlistId, kind))
  if (mem && mem.length > 0) return mem
  const disk = await loadDiskCatalog(playlistId, kind)
  if (disk && disk.length > 0) {
    byKind.set(key(playlistId, kind), disk)
    return disk
  }
  return []
}

export function seedMemoryCatalog(playlistId: string, kind: ContentKind, items: Channel[]) {
  if (!items.length) return
  byKind.set(key(playlistId, kind), items)
}

export function persistCatalogToDisk(playlistId: string, kind: ContentKind, items: Channel[]) {
  if (items.length < 10) return
  void saveDiskCatalog(playlistId, kind, items)
}

/** Atualiza um item no cache (ex.: releasedate vindo dos detalhes). */
export function patchCachedChannel(
  playlistId: string,
  kind: ContentKind,
  id: string,
  patch: Partial<Channel>,
) {
  const cacheKey = key(playlistId, kind)
  const list = byKind.get(cacheKey)
  if (!list) return
  const index = list.findIndex((c) => c.id === id)
  if (index < 0) return
  list[index] = { ...list[index], ...patch }
}

export function clearCatalog(playlistId: string, kind?: ContentKind) {
  const clearKind = (contentKind: ContentKind) => {
    byKind.delete(key(playlistId, contentKind))
    categoriesByKind.delete(key(playlistId, contentKind))
    for (const cacheKey of [...byCategory.keys()]) {
      if (cacheKey.startsWith(`${playlistId}:${contentKind}:`)) byCategory.delete(cacheKey)
    }
  }
  if (kind) {
    clearKind(kind)
    void clearDiskCatalog(playlistId, kind)
  } else {
    for (const contentKind of ['live', 'movie', 'series'] as ContentKind[]) clearKind(contentKind)
    m3uAll.delete(playlistId)
    clearXtreamM3uCache(playlistId)
    void clearDiskCatalog(playlistId)
  }
}
