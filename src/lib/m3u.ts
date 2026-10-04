import type { Channel, ContentKind } from '../types'

// `new RegExp` a cada chamada: um M3U de 200.000 linhas compilava ~1,2 milhão de
// regexes no main thread do renderer antes de comecar a parsear. O nome do
// atributo é sempre literal, então o cache resolve.
const ATTR_CACHE = new Map<string, RegExp[]>()

function attrPatterns(name: string): RegExp[] {
  const cached = ATTR_CACHE.get(name)
  if (cached) return cached
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`${escaped}="([^"]*)"`, 'i'),
    new RegExp(`${escaped}='([^']*)'`, 'i'),
    new RegExp(`${escaped}=([^\\s,]+)`, 'i'),
  ]
  ATTR_CACHE.set(name, patterns)
  return patterns
}

function attr(line: string, name: string) {
  for (const re of attrPatterns(name)) {
    const hit = line.match(re)
    if (hit?.[1]) return hit[1]
  }
  return undefined
}

/**
 * O `#EXTINF` é `<atributos>,<nome exibido>` — e o nome pode conter vírgula
 * ("Top Gear, Temporada 1"). Usar `lastIndexOf(',')` cortava o nome e, como o
 * nome entra no `id` do canal, mudava grupo, ordenação e chave de favorito.
 * A quebra correta é na primeira vírgula FORA de aspas.
 */
function extinfName(line: string): string {
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) return line.slice(i + 1).trim()
  }
  return line.trim()
}

/** O caminho da URL define se é filme, série ou ao vivo. */
export function inferKind(group: string, name: string, url = ''): ContentKind {
  if (/\/series\//i.test(url)) return 'series'
  if (/\/movie\//i.test(url)) return 'movie'
  if (/\/live\//i.test(url) || /\/streaming\//i.test(url)) return 'live'

  const hay = `${group} ${name}`.toLowerCase()
  if (/(serie|séries|series|s\d+\s*e\d+|temporada)/i.test(hay)) return 'series'
  if (/(filme|movie|vod|cinema|lancamento|lançamento)/i.test(hay)) return 'movie'
  return 'live'
}

function streamIdFromUrl(url: string): string | undefined {
  const movie = url.match(/\/movie\/[^/]+\/[^/]+\/([^/.?]+)/i)
  if (movie?.[1]) return movie[1]
  const series = url.match(/\/series\/[^/]+\/[^/]+\/([^/.?]+)/i)
  if (series?.[1]) return series[1]
  const live = url.match(/\/live\/[^/]+\/[^/]+\/([^/.?]+)/i)
  if (live?.[1]) return live[1]
  return undefined
}

function extensionFromUrl(url: string): string | undefined {
  const match = url.match(/\.([a-z0-9]+)(?:\?|$)/i)
  return match?.[1]
}

export function parseM3u(text: string): Channel[] {
  const lines = text.split(/\r?\n/)
  const channels: Channel[] = []
  let pending: string | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      pending = line
      continue
    }
    if (line.startsWith('#')) continue
    if (!pending) continue

    const name = extinfName(pending)
    const group = attr(pending, 'group-title') || 'Geral'
    const logo = attr(pending, 'tvg-logo') || attr(pending, 'logo')
    const tvgId = attr(pending, 'tvg-id')
    const kind = inferKind(group, name, line)
    const streamId = streamIdFromUrl(line)
    channels.push({
      id: streamId ? `${kind}-${streamId}` : `${group}::${name}::${line}`,
      name,
      group,
      url: line,
      logo,
      tvgId,
      kind,
      streamId,
      extension: extensionFromUrl(line),
    })
    pending = null
  }

  return channels
}
