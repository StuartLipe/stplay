import { usesPanelQueue } from './panel-queue.ts'

function proxyBase() {
  if (typeof window !== 'undefined' && window.sturplay?.proxyBase) return window.sturplay.proxyBase
  return '/api/proxy'
}

/**
 * A base que o main entrega carrega o token de sessão do proxy
 * (`/proxy?t=<token>`). Concatenar `?url=` direto produziria
 * `?t=<token>?url=...`, que a URL parser lê como query inteira. Aqui a base é
 * decomposta e os parâmetros são fundidos corretamente.
 */
function buildProxied(base: string, path: '/proxy' | '/stream', key: 'url' | 'u', value: string) {
  const [origin, query = ''] = base.split('?')
  const params = new URLSearchParams(query)
  params.set(key, value)
  const suffix = `${origin.replace(/\/proxy$/, path)}?${params.toString()}`
  return suffix
}

function viaProxy(url: string) {
  if (url.includes('/api/proxy') || url.startsWith('sturplay:')) return url
  return buildProxied(proxyBase(), '/proxy', 'url', url)
}

function viaStream(url: string) {
  const base = proxyBase()
  if (base.startsWith('http://127.0.0.1:')) {
    return buildProxied(base, '/stream', 'u', url)
  }
  return viaProxy(url)
}

/** URL de stream via proxy do Electron (UA + Referer do painel). */
export function playSrc(url: string) {
  if (!url) return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.includes('/api/proxy') || url.includes('/stream?u=') || url.startsWith('sturplay:')) return url
  if (!/^https?:\/\//i.test(url)) return url
  if (/player_api\.php|\/get\.php/i.test(url)) return viaProxy(url)
  if (/\.m3u8(\?|#|$)/i.test(url)) return viaProxy(url)
  return viaStream(url)
}

function normalizeLogo(url?: string) {
  if (!url) return undefined
  let value = url.trim().replace(/^['"]|['"]$/g, '').replace(/&amp;/g, '&')
  if (!value || /^(null|undefined|n\/a|-)$/i.test(value)) return undefined
  if (value.startsWith('//')) value = `https:${value}`
  if (value.startsWith('data:') || value.startsWith('blob:')) return value
  if (!/^https?:\/\//i.test(value)) return undefined
  return value
}

export function mediaSrc(url?: string) {
  const clean = normalizeLogo(url)
  if (!clean) return undefined
  if (clean.startsWith('data:') || clean.startsWith('blob:')) return clean
  return clean
}

/** Imagens (logos/capas) via cache Electron — contorna CORS e headers do painel. */
export function coverSrc(url?: string) {
  const clean = mediaSrc(url)
  if (!clean) return undefined
  if (clean.startsWith('sturplay:')) return clean
  const base = typeof window !== 'undefined' ? window.sturplay?.coverBase : undefined
  if (base && /^https?:\/\//i.test(clean)) {
    return `${base}?url=${encodeURIComponent(clean)}`
  }
  return clean
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let rateLimitUntil = 0

/**
 * Este painel devolve 429 em rajada: medido em `get_live_streams`, uma
 * requisição falha e as 5 seguintes passam. Com PANEL_MAX=2 o app dispara
 * 6+ requests de catálogo de uma vez e estoura a cota. Serializar elimina a
 * rajada — a latência ganha é de segundos, e o custo de não ter é a carga
 * inteira caindo.
 */
const PANEL_MAX = 1
let panelActive = 0
const panelWait: Array<() => void> = []

/** Intervalo mínimo entre requests ao mesmo painel (ms). */
const PANEL_MIN_GAP_MS = 350
let panelLastAt = 0

async function acquirePanel() {
  if (panelActive < PANEL_MAX) {
    panelActive += 1
  } else {
    await new Promise<void>((resolve) => panelWait.push(resolve))
    panelActive += 1
  }
  // Espaça mesmo já tendo pego a vaga, para segurar a cadência entre chamadas.
  const gap = panelLastAt + PANEL_MIN_GAP_MS - Date.now()
  if (gap > 0) await sleep(gap)
  panelLastAt = Date.now()
}

function releasePanel() {
  panelActive = Math.max(0, panelActive - 1)
  const next = panelWait.shift()
  if (next) next()
}

function retryWaitMs(response: Response, attempt: number) {
  const raw = response.headers.get('retry-after')
  if (raw) {
    const asInt = Number(raw)
    if (!Number.isNaN(asInt) && asInt >= 0) return Math.min(Math.max(asInt * 1000, 5000), 60000)
    const asDate = Date.parse(raw)
    if (!Number.isNaN(asDate)) return Math.min(Math.max(0, asDate - Date.now()), 60000)
  }
  // Sem Retry-After o painel usa backoff próprio curto (medido: ~1-3s).
  // O piso de 4s de antes segurava mais que o necessário e, com 3 tentativas,
  // uma rajada de catálogo estourava a cota e derrubava a carga inteira.
  return Math.min(2000 * 2 ** attempt + Math.random() * 750, 30000)
}

async function waitRateLimit() {
  const wait = rateLimitUntil - Date.now()
  if (wait > 0) await sleep(wait)
}

function isXtreamPanelUrl(url: string) {
  return /player_api\.php|\/get\.php/i.test(url)
}

export type FetchOpts = { timeoutMs?: number; priority?: boolean }

async function fetchOnce(url: string, opts?: FetchOpts): Promise<Response> {
  await waitRateLimit()
  const init: RequestInit = { cache: 'no-store' }
  // 240s nos dumps grandes (get_vod_streams / get_series)
  if (opts?.timeoutMs && opts.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    init.signal = AbortSignal.timeout(opts.timeoutMs)
  }

  if (isXtreamPanelUrl(url)) {
    const t0 = Date.now()
    try {
      const r = await fetch(viaProxy(url), init)
      // Loga código e tamanho: separa recusa do painel de download gigante
      // que estoura memória/tempo no renderer.
      logNet('panel ok', url, { status: r.status, ms: Date.now() - t0 })
      return r
    } catch (e) {
      logNet('panel falhou', url, {
        erro: e instanceof Error ? e.message : String(e),
        ms: Date.now() - t0,
        timeoutMs: opts?.timeoutMs ?? null,
      })
      throw e
    }
  }

  try {
    const direct = await fetch(url, init)
    if (direct.ok) return direct
    if (direct.status === 429 || direct.status === 503) return direct
  } catch {
    // proxy
  }
  return fetch(viaProxy(url), init)
}

/** Diagnóstico de rede. Vai pro console do renderer e pro internal-debug.log. */
function logNet(message: string, url: string, data: Record<string, unknown>) {
  const short = url.length > 160 ? url.slice(0, 160) + '...' : url
  console.debug('[net]', message, short, data)
  try {
    const api = (window as unknown as { sturplay?: { dev?: { internalDebug?: (p: unknown) => unknown } } }).sturplay
    if (api?.dev?.internalDebug) {
      void Promise.resolve(
        api.dev.internalDebug({ scope: 'renderer', level: 'info', tag: '[net]', message, data: { url: short, ...data } }),
      ).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}

async function fetchRaw(url: string, opts?: FetchOpts): Promise<Response> {
  const doFetch = async () => {
    let last: Response | undefined
    // 429 deste painel chega em rajada: uma carga de catálogo dispara 6+ requests
    // e a cota estoura. 3 tentativas não sobrevivem; 6 com espera crescente, sim.
    // O custo é latência em caso patológico, não throughput no caso normal.
    const maxAttempts = 6
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await fetchOnce(url, opts)
      last = response
      if (response.ok) return response
      if (response.status === 429 || response.status === 503) {
        const wait = retryWaitMs(response, attempt)
        rateLimitUntil = Math.max(rateLimitUntil, Date.now() + wait)
        logNet('rate limit, aguardando', url, {
          attempt: attempt + 1,
          de: maxAttempts,
          esperaMs: Math.round(wait),
          status: response.status,
        })
        await sleep(wait)
        continue
      }
      break
    }
    logNet('download falhou apos tentativas', url, { status: last?.status ?? 0 })
    throw new Error(`Falha ao baixar (${last?.status || 0})`)
  }

  if (usesPanelQueue(url, opts)) {
    await acquirePanel()
    try {
      return await doFetch()
    } finally {
      releasePanel()
    }
  }
  return doFetch()
}

export async function fetchText(url: string, opts?: FetchOpts) {
  const response = await fetchRaw(url, opts)
  const text = await response.text()
  // Só o tamanho em log; a playlist deste painel tem >100MB e 300k+ canais.
  logNet('texto recebido', url, { bytes: text.length })
  return text
}

export async function fetchJson<T>(url: string, opts?: FetchOpts): Promise<T> {
  const response = await fetchRaw(url, opts)
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<')) {
    // HTML aqui = o painel devolveu página de erro/login, não JSON.
    logNet('json invalido', url, {
      bytes: text.length,
      inicio: trimmed.slice(0, 120),
    })
    throw new Error('Resposta da API inválida (bloqueio/vazio)')
  }
  try {
    return JSON.parse(trimmed) as T
  } catch {
    logNet('json parse falhou', url, { bytes: text.length })
    throw new Error('Resposta da API inválida')
  }
}

/** Timeout longo dos dumps de catálogo. */
export const PANEL_LARGE_TIMEOUT_MS = 240_000
