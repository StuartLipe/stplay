import type { ContentKind } from '../types'
import { playSrc } from './proxy'

export type StreamCompat = 'I' | 'E' | 'F' | '?'

export type StreamCompatInfo = {
  compat: StreamCompat
  reason: string
}

const DRM_HINTS = /widevine|playready|fairplay|clearkey|\bdrm\b/i
const HLS_URL = /\.m3u8(\?|#|$)/i
const DASH_URL = /\.mpd(\?|#|$)/i
const HLS_OUTPUT = /[?&]output=(m3u8|hls)\b/i
const EXTERNAL_EXT = /\.(mkv|avi|wmv|flv|rmvb?)(\?|#|$)/i
const DUAL_EXT = /\.(mp4|m4v|webm)(\?|#|$)/i
const TS_EXT = /\.ts(\?|#|$)/i

const INTERNAL_CT = /mpegurl|dash\+xml|application\/x-mpegurl/i
const EXTERNAL_CT = /video\/x-matroska|video\/x-msvideo|video\/x-flv|video\/mp2t/i
const DUAL_CT = /^video\/(mp4|webm)/i

const cache = new Map<string, StreamCompatInfo>()
const inflight = new Map<string, Promise<StreamCompatInfo>>()

let activeProbes = 0
const MAX_PROBES = 4
const probeQueue: Array<() => void> = []

function acquireProbe() {
  if (activeProbes < MAX_PROBES) {
    activeProbes += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => probeQueue.push(resolve))
}

function releaseProbe() {
  activeProbes = Math.max(0, activeProbes - 1)
  const next = probeQueue.shift()
  if (next) {
    activeProbes += 1
    next()
  }
}

function extFromUrl(url: string) {
  const match = url.match(/\.([a-z0-9]+)(?:\?|#|$)/i)
  return match?.[1]?.toLowerCase() || ''
}

function isPlayableUrl(url?: string) {
  return Boolean(url?.trim() && /^https?:\/\//i.test(url.trim()))
}

/** Classificação síncrona pela URL (e tipo de conteúdo). */
export function classifyStreamByUrl(url?: string, kind?: ContentKind): StreamCompatInfo {
  const value = url?.trim() || ''
  if (!value) return { compat: '?', reason: 'URL ausente' }
  if (!/^https?:\/\//i.test(value)) {
    if (kind === 'series' || /^\d+$/.test(value)) {
      return { compat: '?', reason: 'Série sem URL de stream (abrir episódio)' }
    }
    return { compat: '?', reason: 'URL inválida' }
  }

  if (DRM_HINTS.test(value)) return { compat: 'I', reason: 'DRM indicado na URL' }
  if (HLS_URL.test(value) || DASH_URL.test(value) || HLS_OUTPUT.test(value)) {
    return { compat: 'I', reason: 'Manifesto HLS/DASH (.m3u8 / .mpd)' }
  }
  if (/\/live\//i.test(value)) {
    if (TS_EXT.test(value)) return { compat: 'I', reason: 'Ao vivo .ts — convertido para HLS no player interno' }
    return { compat: 'I', reason: 'Stream ao vivo (HLS)' }
  }
  if (EXTERNAL_EXT.test(value)) {
    return { compat: 'E', reason: `Formato .${extFromUrl(value)} — reprodutor externo` }
  }
  if (TS_EXT.test(value)) return { compat: 'E', reason: 'MPEG-TS — reprodutor externo' }
  if (DUAL_EXT.test(value)) return { compat: 'F', reason: `Formato .${extFromUrl(value)} — interno e externo` }

  return { compat: '?', reason: 'Formato não identificado na URL' }
}

function classifyFromHeaders(contentType: string, url: string): StreamCompatInfo | null {
  const ct = contentType.toLowerCase().split(';')[0]?.trim() || ''
  if (!ct) return null

  if (DRM_HINTS.test(contentType)) return { compat: 'I', reason: 'DRM nos headers HTTP' }
  if (INTERNAL_CT.test(ct)) return { compat: 'I', reason: `Content-Type: ${ct}` }
  if (EXTERNAL_CT.test(ct)) return { compat: 'E', reason: `Content-Type: ${ct}` }
  if (DUAL_CT.test(ct)) return { compat: 'F', reason: `Content-Type: ${ct}` }

  if (ct === 'application/octet-stream') {
    const urlInfo = classifyStreamByUrl(url)
    if (urlInfo.compat !== '?') return urlInfo
  }

  return null
}

function mergeClassification(urlInfo: StreamCompatInfo, headerInfo: StreamCompatInfo | null): StreamCompatInfo {
  if (!headerInfo) return urlInfo
  if (urlInfo.compat === '?' || headerInfo.compat !== '?') return headerInfo
  return urlInfo
}

/** Sonda headers HTTP via proxy (Range mínimo, sem alterar servidor). */
export async function probeStreamHeaders(url: string): Promise<StreamCompatInfo> {
  const cached = cache.get(url)
  if (cached) return cached

  const pending = inflight.get(url)
  if (pending) return pending

  const urlInfo = classifyStreamByUrl(url)
  if (!isPlayableUrl(url)) {
    cache.set(url, urlInfo)
    return urlInfo
  }

  const task = (async () => {
    await acquireProbe()
    try {
      const response = await fetch(playSrc(url), {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(8000)
          : undefined,
      })

      const contentType = response.headers.get('content-type') || ''
      const headerInfo = classifyFromHeaders(contentType, url)
      const result = mergeClassification(urlInfo, headerInfo)

      if (result.compat === '?' && !response.ok && response.status !== 206) {
        return { compat: 'E' as const, reason: `HTTP ${response.status} — pode exigir player externo` }
      }

      cache.set(url, result)
      return result
    } catch {
      cache.set(url, urlInfo)
      return urlInfo
    } finally {
      releaseProbe()
      inflight.delete(url)
    }
  })()

  inflight.set(url, task)
  return task
}

export function getStreamCompatCached(url?: string): StreamCompatInfo | undefined {
  if (!url) return undefined
  return cache.get(url)
}

export const STREAM_COMPAT_LABELS: Record<StreamCompat, string> = {
  I: 'Player interno (HTML5 + hls.js)',
  E: 'Player externo (VLC / MPC-HC)',
  F: 'Compatível com ambos',
  '?': 'Formato indefinido',
}
