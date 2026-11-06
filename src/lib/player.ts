import Hls from 'hls.js'
import { playSrc } from './proxy'

function isHlsManifest(url: string) {
  return /\.m3u8(\?|#|$)/i.test(url) || /[?&]output=(m3u8|hls)\b/i.test(url)
}

function looksLikeLiveUrl(url: string) {
  return /\/live\//i.test(url) || /[?&]output=(ts|m3u8|hls)\b/i.test(url)
}

/** Xtream/M3U ao vivo em .ts nÃ£o toca no Chromium â€” o painel costuma servir o mesmo id em .m3u8. */
export function toLiveHlsUrl(url: string) {
  let next = url
  next = next.replace(/([?&]output=)ts\b/i, '$1m3u8')
  next = next.replace(/(\/live\/[^/?#]+\/[^/?#]+\/[^/?#]+)\.(ts|mp4)(\?|#|$)/i, '$1.m3u8$3')
  next = next.replace(/(\/live\/[^/?#]+\/[^/?#]+\/\d+)(\?|#|$)/i, (full, path: string, end: string) => {
    if (/\.[a-z0-9]+$/i.test(path)) return full
    return `${path}.m3u8${end}`
  })
  if (!isHlsManifest(next) && /\.ts(\?|#|$)/i.test(next)) {
    next = next.replace(/\.ts(\?|#|$)/i, '.m3u8$1')
  }
  return next
}

export function hlsSourceCandidates(url: string, live: boolean) {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (value: string) => {
    const next = value?.trim()
    if (!next || seen.has(next) || !isHlsManifest(next)) return
    seen.add(next)
    out.push(next)
  }
  // Ordem = velocidade: tenta o original primeiro (sem conversÃ£o = 1 request a menos),
  // depois convertido, depois variantes output= (alguns painÃ©is sÃ³ abrem com output=).
  add(url)
  if (live) {
    add(toLiveHlsUrl(url))
    try {
      const u = new URL(url)
      // output=m3u8 e output=hls como fallback (painel Xtream antigo)
      for (const outParam of ['m3u8', 'hls']) {
        const v = new URL(u.href)
        v.searchParams.set('output', outParam)
        add(v.href)
      }
    } catch {
      // url relativa â€” ignora variantes
    }
  }
  return out
}

/** O painel Ã s vezes manda .mp4 e o arquivo Ã© .mkv/.avi â€” o Chromium recusa e mostra esse erro. */
function vodUrlVariants(url: string): string[] {
  const match = url.match(/^(https?:\/\/.+\.)([a-z0-9]+)(\?.*)?$/i)
  if (!match) return [url]
  const prefix = match[1]
  const current = match[2].toLowerCase()
  const query = match[3] || ''
  const seen = new Set<string>()
  const out: string[] = []
  for (const ext of [current, 'mp4', 'mkv', 'avi', 'ts']) {
    const next = `${prefix}${ext}${query}`
    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }
  return out
}

function engineMemoryKey(url: string) {
  try {
    const u = new URL(url)
    return `stplay.engine:${u.host}${u.pathname}`
  } catch {
    return null
  }
}

function hostMemoryKey(url: string) {
  try {
    return `stplay.hostffmpeg:${new URL(url).host}`
  } catch {
    return null
  }
}

function readHostFfmpegCount(url: string): number {
  try {
    const key = hostMemoryKey(url)
    if (!key) return 0
    return Number(localStorage.getItem(key) || 0) || 0
  } catch {
    return 0
  }
}

function bumpHostFfmpeg(url: string) {
  try {
    const key = hostMemoryKey(url)
    if (key) localStorage.setItem(key, String(readHostFfmpegCount(url) + 1))
  } catch {
    // ignore
  }
}

function readEngineMemory(url: string): string | null {
  try {
    const key = engineMemoryKey(url)
    if (!key) return null
    const raw = localStorage.getItem(key)
    return raw === 'ffmpeg' || raw === 'hls' ? raw : null
  } catch {
    return null
  }
}

function writeEngineMemory(url: string, mode: 'ffmpeg' | 'hls') {
  try {
    const key = engineMemoryKey(url)
    if (key) localStorage.setItem(key, mode)
    if (mode === 'ffmpeg') bumpHostFfmpeg(url)
  } catch {
    // ignore
  }
}

function redactUrl(url: string) {
  try {
    const u = new URL(url)
    // Esconde user/pass/token do painel: /live/u/p/id -> /live/*/*/id
    const p = u.pathname.replace(/(\/live\/)[^/]+\/[^/]+(\/.*)?/i, '$1*/*$2')
    return `${u.protocol}//${u.host}${p}${u.search ? '?â€¦' : ''}`
  } catch {
    return url.slice(0, 60)
  }
}

function dbg(event: string, data?: unknown) {
  try {
    console.debug(`[internal-dbg] ${event}`, data ?? '')
  } catch {
    // ignore
  }
  try {
    const w = window as unknown as {
      sturplay?: { dev?: { internalDebug?: (p: unknown) => void } }
    }
    void w.sturplay?.dev?.internalDebug?.({ scope: 'internal', event, data: data ?? null })
  } catch {
    // ignore (navegador sem preload)
  }
}

function isVideoRendering(video: HTMLVideoElement) {
  return video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime > 0.05
}

/** MantÃ©m o mudo escolhido pelo utilizador â€” playWithFallback nÃ£o deve reativar o som. */
export function setPlayerKeepMuted(video: HTMLVideoElement, keep: boolean) {
  if (keep) video.dataset.keepMuted = '1'
  else delete video.dataset.keepMuted
}

function playWithFallback(video: HTMLVideoElement) {
  // NUNCA mexe em mute aqui â€” mutar/desmutar a cada fragmento causava
  // travamento + som mudo no meio do live (ESPN FHD).
  // SÃ³ dÃ¡ play se estiver pausado; o mute inicial Ã© tratado uma vez no attach.
  if (!video.paused && video.currentTime > 0) return
  try {
    const p = video.play()
    if (p === undefined) return
    void p.catch(() => undefined)
  } catch {
    // ignore
  }
}

function ensureUnmutedOnce(video: HTMLVideoElement) {
  // Chamado 1x apÃ³s autoplay com som liberado (gesto do usuÃ¡rio / canplay).
  // Respeita o mudo escolhido pelo utilizador.
  try {
    if (video.dataset.keepMuted === '1') {
      video.muted = true
      return
    }
    if (video.muted && video.volume > 0) {
      video.muted = false
    }
  } catch {
    // ignore
  }
}

export interface AudioTrack {
  id: number
  name: string
  lang?: string
}

export interface SubtitleTrack {
  id: number
  name: string
  lang?: string
}

export interface PlayerControls {
  setAudioTrack: (id: number) => void
  setSubtitleTrack: (id: number | null) => void
}

function formatVideoError(video: HTMLVideoElement) {
  const err = video.error
  if (err?.code === 3) return 'Codec de vÃ­deo ou Ã¡udio nÃ£o suportado neste reprodutor'
  if (err?.code === 4) return 'Este arquivo nÃ£o toca no player interno (formato/codec).'
  if (err?.code === 2) return 'Erro de conexÃ£o ao carregar o vÃ­deo'
  return 'Erro ao reproduzir o vÃ­deo'
}

export interface PlayerAttachOptions {
  live?: boolean
  /** UHD / esportes â€” mais buffer e timeouts sem sacrificar estabilidade */
  heavy?: boolean
  onError?: (err: string) => void
  onAudioTracks?: (tracks: AudioTrack[]) => void
  onSubtitleTracks?: (tracks: SubtitleTrack[]) => void
  controls?: PlayerControls
}

function createProxyLoader(elapsed: () => number) {
  const BaseLoader = Hls.DefaultConfig.loader
  // Igual players web de referÃªncia (direto no painel, sem proxy).
  // Tenta DIRETO primeiro (rÃ¡pido como STUR); se falhar (CORS/403), cai pro proxy.
  // Falha direta Ã© rÃ¡pida (browser rejeita na hora); sÃ³ rede travada paga timeout.
  return class extends BaseLoader {
    load(
      context: Parameters<InstanceType<typeof BaseLoader>['load']>[0],
      config: Parameters<InstanceType<typeof BaseLoader>['load']>[1],
      callbacks: Parameters<InstanceType<typeof BaseLoader>['load']>[2],
    ) {
      const originalUrl = String(context.url || '')
      const proxied = playSrc(originalUrl)
      if (proxied === originalUrl) {
        super.load(context, config, callbacks)
        return
      }
      let finished = false
      const kind = context.type || 'unknown'
      const directCb = {
        ...callbacks,
        onSuccess: (
          response: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onSuccess']>[0],
          stats: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onSuccess']>[1],
          loadedCtx: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onSuccess']>[2],
          networkDetails: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onSuccess']>[3],
        ) => {
          if (finished) return
          finished = true
          dbg('load-ok', { kind, via: 'direct', t: elapsed() })
          callbacks.onSuccess(response, stats, loadedCtx, networkDetails)
        },
        onError: (
          error: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onError']>[0],
          loadedCtx: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onError']>[1],
          networkDetails: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onError']>[2],
          stats: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onError']>[3],
        ) => {
          if (finished) return
          finished = true
          dbg('load-fallback', { kind, t: elapsed() })
          // Direto falhou -> proxy com URL original preservada pro HLS resolver relativo
          try {
            super.load({ ...context, url: proxied }, config, {
              ...callbacks,
              onSuccess(response, stats, _loadedCtx, netDetails) {
                if (response) response.url = originalUrl
                dbg('load-ok', { kind, via: 'proxy', t: elapsed() })
                callbacks.onSuccess(response, stats, context, netDetails)
              },
            })
          } catch {
            callbacks.onError(error, loadedCtx, networkDetails, stats)
          }
        },
        onTimeout: (
          stats: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onTimeout']>[0],
          loadedCtx: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onTimeout']>[1],
          networkDetails: Parameters<Parameters<InstanceType<typeof BaseLoader>['load']>[2]['onTimeout']>[2],
        ) => {
          if (finished) return
          finished = true
          try {
            super.load({ ...context, url: proxied }, config, {
              ...callbacks,
              onSuccess(response, s, _loadedCtx, netDetails) {
                if (response) response.url = originalUrl
                callbacks.onSuccess(response, s, context, netDetails)
              },
            })
          } catch {
            callbacks.onTimeout(stats, loadedCtx, networkDetails)
          }
        },
      }
      try {
        super.load(context, config, directCb)
      } catch {
        super.load({ ...context, url: proxied }, config, {
          ...callbacks,
          onSuccess(response, stats, _loadedCtx, networkDetails) {
            if (response) response.url = originalUrl
            callbacks.onSuccess(response, stats, context, networkDetails)
          },
        })
      }
    }
  }
}

function createHls(live: boolean, heavy = false, elapsed: () => number = () => 0) {
  const shared = {
    enableWorker: true,
    lowLatencyMode: false,
    autoStartLoad: true,
    loader: createProxyLoader(elapsed),
    startFragPrefetch: true,
    progressive: true,
    startLevel: 0,
    testBandwidth: false,
    nudgeOffset: 0.2,
    nudgeMaxRetry: 8,
    appendErrorMaxRetry: 5,
    xhrSetup: (xhr: XMLHttpRequest) => {
      try {
        xhr.withCredentials = false
      } catch {
        // ignore
      }
    },
  }

  if (live) {
    return new Hls({
      ...shared,
      liveDurationInfinity: true,
      // STUR abre na borda (0 delay); HLS com 2 segmentos atrÃ¡s = 12s sÃ³ de delay.
      // 1 = cola no live igual mpv, abre rÃ¡pido; buffer + watchdog seguram sem travar.
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 5,
      maxLiveSyncPlaybackRate: 1.0,
      initialLiveManifestSize: 1,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      backBufferLength: heavy ? 20 : 12,
      // Start rÃ¡pido vem do edge (count 1) + nÃ­vel 0, nÃ£o do buffer curto.
      // Buffer maior segura jitter de segmento via proxy sem travar depois.
      maxBufferLength: heavy ? 15 : 12,
      maxMaxBufferLength: heavy ? 40 : 30,
      maxBufferSize: heavy ? 64 * 1024 * 1024 : 48 * 1024 * 1024,
      maxBufferHole: 0.5,
      // ComeÃ§a baixo pra abrir rÃ¡pido e nÃ£o congelar no 1Âº frame FHD, sobe sozinho
      abrEwmaDefaultEstimate: 1_500_000,
      abrEwmaFastLive: 3,
      abrBandWidthFactor: 0.8,
      abrBandWidthUpFactor: 0.7,
      capLevelToPlayerSize: false,
      // 0 = abre rÃ¡pido no nÃ­vel leve; ABR sobe pra FHD sozinho
      startLevel: 0,
      fragLoadingMaxRetry: 4,
      // Manifest/level: 2 tentativas e troca de candidato â€” 4x8s = 32s num SD Ã© demais
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 2,
      // Painel lento (>6s) existia e abria antes â€” 8s/10s dÃ¡ chance sem spinner eterno
      fragLoadingTimeOut: 10_000,
      manifestLoadingTimeOut: 8_000,
      levelLoadingTimeOut: 8_000,
    })
  }

  return new Hls({
    ...shared,
    backBufferLength: 20,
    // VOD: puxa o arquivo inteiro logo de cara (carrega "de uma vez") em vez
    // de seguir colado no playback â€” com 8s o loader sÃ³ rodava DURANTE a
    // reproduÃ§Ã£o e o vÃ­deo ficava choppy atÃ© o fim. 30min/1GB de janela Ã 
    // frente: carrega tudo em segundos e ainda segura rede lenta sem travar.
    maxBufferLength: 1800,
    maxMaxBufferLength: 1800,
    maxBufferSize: 1024 * 1024 * 1024,
    maxBufferHole: 0.5,
    abrEwmaDefaultEstimate: 2_500_000,
    capLevelToPlayerSize: false,
    fragLoadingMaxRetry: 6,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    fragLoadingTimeOut: 12_000,
    manifestLoadingTimeOut: 8_000,
    levelLoadingTimeOut: 8_000,
  })
}

export function attachPlayer(
  video: HTMLVideoElement,
  url: string,
  onError?: (err: string) => void,
  onAudioTracks?: (tracks: AudioTrack[]) => void,
  onSubtitleTracks?: (tracks: SubtitleTrack[]) => void,
  controls?: PlayerControls,
) {
  return attachPlayerEx(video, url, {
    onError,
    onAudioTracks,
    onSubtitleTracks,
    controls,
  })
}

export function attachPlayerEx(video: HTMLVideoElement, url: string, opts: PlayerAttachOptions = {}) {
  const { onError, onAudioTracks, onSubtitleTracks, controls } = opts
  const live = Boolean(opts.live || looksLikeLiveUrl(url))
  const heavy = Boolean(opts.heavy)
  const t0 = performance.now()
  const elapsed = () => Math.round(performance.now() - t0)
  let firstFragLogged = false
  dbg('start', { url: redactUrl(url), live, heavy })
  let hls: Hls | null = null
  let destroyed = false
  let hlsRetry = 0
/*
 * Quantos `networkError` NÃƒO-fatais a corrente aceita antes de ser tratada como
 * trava. Medido no painel do dono: 38 em 35s, ~1,3s de intervalo, todos
 * `aborted`, e o `MANIFEST_PARSED` nunca veio. Um `aborted` isolado Ã© o
 * hls.js trocando de segmento e nÃ£o deve incomodar; 12 seguidos sem nenhum
 * progresso Ã© o spinning infinito.
 */
const HLS_SOFT_FAIL_MAX = 12
let hlsSoftFail = 0

  try {
    video.pause()
  } catch {
    // ignore
  }
  video.removeAttribute('src')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('playsinline', '')
  video.setAttribute('autoplay', '')

  // Fallback progressivo: VOD tenta variantes; live TS o Chromium nÃ£o toca,
  // entÃ£o nÃ£o adianta enrolar em 5 variantes x 18s (vira spinner de 90s).
  // Live tenta sÃ³ o original via proxy com timeout curto, depois erro direto.
  const progressiveVariants = isHlsManifest(url)
    ? [playSrc(toLiveHlsUrl(url))]
    : live
      ? [playSrc(url)]
      : [playSrc(url), ...vodUrlVariants(url).map((item) => playSrc(item))].filter(
          (v, i, a) => v && a.indexOf(v) === i,
        )
  let variantIndex = -1

  const loadProgressive = (src: string) => {
    if (destroyed) return
    video.src = src
    video.autoplay = true
    video.playsInline = true
    video.load()
    playWithFallback(video)
    if (live) startFreezeWatchdog()
    const onMeta = () => {
      if (!destroyed) playWithFallback(video)
    }
    video.addEventListener('loadedmetadata', onMeta, { once: true })
    scheduleLoadTimeout()
    // Live progressivo (.ts via proxy o Chromium nÃ£o toca): 10s e erro, sem enrolar
    scheduleBlankCheck(live ? 10_000 : 30_000)
  }

  let loadTimer = 0
  let blankTimer = 0
  let nudgeTimer = 0
  let retryTimer = 0
  let autoRetried = false
  let freezeTimer = 0
  let lastFreezeTime = -1
  let freezeStuckCount = 0
  const clearTimers = () => {
    window.clearTimeout(loadTimer)
    window.clearTimeout(blankTimer)
    window.clearTimeout(nudgeTimer)
    window.clearTimeout(retryTimer)
    window.clearInterval(freezeTimer)
  }
  // Watchdog anti-congelamento live: checa a cada 1.5s; no 1Âº travamento
  // jÃ¡ derruba pro nÃ­vel leve + volta pra borda (antes esperava 2x em 2.5s).
  // No caminho ffmpeg (hls destruÃ­do) sem dados novos: religa o remux com fresh=1,
  // senÃ£o fica congelado na borda pra sempre igual o log mostrou (cur==bufEnd 100s).
  let lastFfmpegRestart = 0
  const startFreezeWatchdog = () => {
    window.clearInterval(freezeTimer)
    if (!live) return
    lastFreezeTime = video.currentTime
    freezeStuckCount = 0
    freezeTimer = window.setInterval(() => {
      if (destroyed || video.paused) {
        lastFreezeTime = video.currentTime
        return
      }
      const cur = video.currentTime
      if (Math.abs(cur - lastFreezeTime) > 0.15) {
        lastFreezeTime = cur
        freezeStuckCount = 0
        return
      }
      // travou
      freezeStuckCount += 1
      lastFreezeTime = cur
      try {
        const bufEnd = (() => {
          try {
            return video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : -1
          } catch {
            return -1
          }
        })()
        dbg('freeze', { t: elapsed(), cur: Math.round(cur * 10) / 10, bufEnd: Math.round(bufEnd * 10) / 10, count: freezeStuckCount })
        if (hls) {
          try {
            hls.nextLevel = 0
          } catch {
            // ignore
          }
        }
        const buffered = video.buffered
        if (buffered.length > 0) {
          const end = buffered.end(buffered.length - 1)
          const gap = end - cur
          if (gap > 0.4) {
            video.currentTime = Math.max(0, end - 0.3)
            void video.play().catch(() => undefined)
            return
          }
        }
        // sem buffer: volta pra borda do live
        if (hls) {
          try {
            hls.startLoad(-1)
          } catch {
            // ignore
          }
          void video.play().catch(() => undefined)
          return
        }
        // Sem hls (ffmpeg/progressivo) e sem dado novo hÃ¡ 3 checagens: o remux
        // prendeu no painel â€” religa com pipe novo (10s entre religaÃ§Ãµes).
        if (live && freezeStuckCount >= 3 && performance.now() - lastFfmpegRestart > 10000) {
          lastFfmpegRestart = performance.now()
          freezeStuckCount = 0
          dbg('ffmpeg-restart', { t: elapsed(), cur: Math.round(cur * 10) / 10 })
          void (async () => {
            try {
              const w = window as unknown as {
                sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number, f?: boolean) => Promise<{ ok: boolean; url?: string }> } }
              }
              const res = await w.sturplay?.dev?.ffmpegWrap?.(url, 0, true)
              if (destroyed) return
              if (res?.ok && res.url) {
                video.src = res.url
                video.load()
                void video.play().catch(() => undefined)
              }
            } catch {
              // prÃ³xima checagem tenta de novo
            }
          })()
        }
      } catch {
        // ignore
      }
    }, 1500)
  }
  // Erro final com 1 retry automÃ¡tico no live (painel instÃ¡vel: 1Âª tentativa
  // falha, retry abre â€” igual vocÃª viu no Cartoon). SÃ³ mostra erro na 2Âª falha.
  let beginFn: (() => void) | null = null
  // Retry pede pipe novo (fresh): nÃ£o reaproveita proc que pode estar preso na falha anterior
  let needFresh = false
  const finalError = (message: string) => {
    if (destroyed) return
    if (live && !autoRetried) {
      autoRetried = true
      needFresh = true
      dbg('auto-retry', { t: elapsed() })
      retryTimer = window.setTimeout(() => {
        if (destroyed) return
        destroyHls()
        hlsIndex = 0
        variantIndex = -1
        ffmpegVideoTried = false
        hlsRetry = 0
        beginFn?.()
      }, 2500)
      return
    }
    onError?.(message)
  }
  const scheduleLoadTimeout = () => {
    window.clearTimeout(loadTimer)
    if (live || hls) return
    loadTimer = window.setTimeout(() => {
      if (destroyed) return
      if (video.readyState < 1 && !video.error) onVideoError()
    }, 30_000)
  }
  const scheduleBlankCheck = (ms: number) => {
    window.clearTimeout(blankTimer)
    blankTimer = window.setTimeout(() => {
      if (destroyed || video.error) return
      if (isVideoRendering(video)) return
      if (video.readyState >= 2 && video.currentTime > 0.5) return
      // Tocando com dados mas sem frame e sem tempo = dado inÃºtil (codec/nÃ­vel ruim).
      // Antes dava return e ficava spinner infinito com o botÃ£o em pause.
      // Agora cai pro prÃ³ximo candidato/motor em vez de rodar pra sempre.
      if (hls) {
        const hasData = video.readyState >= 1 && video.currentTime > 0.5
        if (hasData) return
        failHls(live ? 'Live nÃ£o carregou â€” tentando prÃ³ximo motor' : 'Demorou para abrir o stream ao vivo')
        return
      }
      // Progressivo travado sem frame: antes jogava o box de erro na tela e a
      // cadeia continuava em background (virava "da erro e depois carrega").
      // Agora salta direto pro remux ffmpeg â€” o mesmo fim que o error event
      // chegava â€” e o box sÃ³ aparece se o remux tambÃ©m falhar.
      variantIndex = progressiveVariants.length
      onVideoError()
    }, ms)
  }
  const schedulePlayNudge = () => {
    window.clearTimeout(nudgeTimer)
    nudgeTimer = window.setTimeout(() => {
      if (destroyed) return
      if (!video.paused && video.currentTime > 0) return
      playWithFallback(video)
    }, 50)
  }

  const destroyHls = () => {
    if (!hls) return
    try {
      hls.destroy()
    } catch {
      // ignore
    }
    hls = null
  }

  let ffmpegVideoTried = false
  const onVideoError = () => {
    if (destroyed || hls) return
    variantIndex += 1
    if (variantIndex < progressiveVariants.length) {
      loadProgressive(progressiveVariants[variantIndex])
      return
    }
    // Progressivo esgotou: tenta remux ffmpeg 1x antes de declarar codec morto
    if (!ffmpegVideoTried) {
      ffmpegVideoTried = true
      void tryFfmpegOrError(formatVideoError(video))
      return
    }
    finalError(formatVideoError(video))
  }

  const tryFfmpegOrError = async (message: string) => {
    if (destroyed) return
    dbg('ffmpeg-fallback', { t: elapsed(), url: redactUrl(url), from: 'video-error' })
    try {
      const w = window as unknown as {
        sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number) => Promise<{ ok: boolean; url?: string }> } }
      }
      const wrap = w.sturplay?.dev?.ffmpegWrap
      if (wrap) {
        const res = await wrap(url, 0)
        if (destroyed) return
        if (res?.ok && res.url) {
          writeEngineMemory(url, 'ffmpeg')
          dbg('ffmpeg-ok', { t: elapsed() })
          variantIndex = progressiveVariants.length
          loadProgressive(res.url)
          return
        }
      }
    } catch {
      // cai no erro abaixo
    }
    if (!destroyed) finalError(message)
  }

  video.addEventListener('error', onVideoError)

  const onLoadedData = () => {
    scheduleBlankCheck(live ? 15_000 : 30_000)
    playWithFallback(video)
  }
  const onCanPlay = () => {
    if (video.paused) playWithFallback(video)
    else ensureUnmutedOnce(video)
    schedulePlayNudge()
  }
  // Anti-travamento live (ESPN FHD): empurra 0.25s pra frente quando prende em waiting
  const onStallNudge = () => {
    if (destroyed || !live) return
    try {
      if (!video.paused && video.readyState >= 2) {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const end = buffered.end(buffered.length - 1)
          const gap = end - video.currentTime
          if (gap > 0.4 && gap < 8) video.currentTime = end - 0.25
        }
      }
    } catch {
      // ignore
    }
  }
  video.addEventListener('loadeddata', onLoadedData)
  video.addEventListener('canplay', onCanPlay)
  video.addEventListener('waiting', onStallNudge)
  video.addEventListener('stalled', onStallNudge)
  // Autoplay com som bloqueado pelo Chromium deixa pausado.
  // MantÃ©m mutado atÃ© o 1Âº frame tocando, aÃ­ devolve o som se o usuÃ¡rio nÃ£o mutou.
  const onFirstPlaying = () => {
    dbg('playing', { t: elapsed() })
    ensureUnmutedOnce(video)
  }
  video.addEventListener('playing', onFirstPlaying, { once: true })

  const destroy = () => {
    destroyed = true
    clearTimers()
    video.removeEventListener('error', onVideoError)
    video.removeEventListener('loadeddata', onLoadedData)
    video.removeEventListener('canplay', onCanPlay)
    video.removeEventListener('waiting', onStallNudge)
    video.removeEventListener('stalled', onStallNudge)
    video.removeEventListener('playing', onFirstPlaying)
    destroyHls()
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
    } catch {
      // ignore
    }
  }

  const hlsCandidates = hlsSourceCandidates(url, live)
  let hlsIndex = 0

  const failHls = (message: string, details?: string) => {
    if (destroyed) return
    if (isVideoRendering(video) && !video.paused) return
    dbg('fail-hls', { t: elapsed(), message, details: details ?? null, hlsIndex })
    // Live com mais de 8s jÃ¡ queimou tempo demais em candidato: pula o resto e
    // vai direto pro progressivo/ffmpeg (meta: abrir em atÃ© 10s na 1Âª vez).
    if (live && elapsed() > 8000) hlsIndex = hlsCandidates.length
    else hlsIndex += 1
    if (hlsIndex < hlsCandidates.length) {
      startHls(hlsCandidates[hlsIndex])
      return
    }
    // HLS esgotou: tenta progressivo (original via proxy) e por Ãºltimo o
    // remux ffmpeg local (TS/HEVC/AC3 que o Chromium nÃ£o abre sozinho).
    destroyHls()
    variantIndex = -1
    let ffmpegTried = false
    const tryProgressive = () => {
      if (destroyed) return
      variantIndex += 1
      if (variantIndex < progressiveVariants.length) {
        loadProgressive(progressiveVariants[variantIndex])
        return
      }
      if (!ffmpegTried) {
        ffmpegTried = true
        void tryFfmpegFallback()
        return
      }
      finalError(details ? `${message} (${details})` : message)
    }
    const tryFfmpegFallback = async () => {
      if (destroyed) return
      dbg('ffmpeg-fallback', { t: elapsed(), url: redactUrl(url) })
      try {
        const w = window as unknown as {
          sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number) => Promise<{ ok: boolean; url?: string }> } }
        }
        const wrap = w.sturplay?.dev?.ffmpegWrap
        if (!wrap) {
          finalError(details ? `${message} (${details})` : message)
          return
        }
        const res = await wrap(url, 0)
        if (destroyed) return
        if (res?.ok && res.url) {
          writeEngineMemory(url, 'ffmpeg')
          dbg('ffmpeg-ok', { t: elapsed() })
          loadProgressive(res.url)
          return
        }
        finalError(details ? `${message} (${details})` : message)
      } catch {
        if (!destroyed) finalError(details ? `${message} (${details})` : message)
      }
    }
    tryProgressive()
  }

  const startHls = (src: string) => {
    if (destroyed) return
    destroyHls()
    hlsRetry = 0
    let audioSwapDone = false
    hls = createHls(live, heavy, elapsed)
    hlsSoftFail = 0
    hls.attachMedia(video)
    hls.loadSource(src)
    // Se o manifest travar sem parse (hang), o blank estoura e troca de candidato.
    // Live em 10s pra cair rÃ¡pido pro ffmpeg (meta: abrir em atÃ© 10s).
    scheduleBlankCheck(live ? 10_000 : 30_000)
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      if (destroyed || !hls) return
      // Progresso real: o circuito de erro nÃ£o-fatal volta a zero. A partir
      // daqui o `aborted` isolado Ã© o hls.js trocando de segmento.
      hlsSoftFail = 0
      try {
        dbg('manifest', {
          t: elapsed(),
          levels: data?.levels?.length ?? hls.levels?.length ?? 0,
          url: redactUrl(src),
        })
      } catch {
        // ignore
      }
      playWithFallback(video)
      startFreezeWatchdog()
      scheduleBlankCheck(live ? 10_000 : 30_000)
    })
    // NÃƒO dÃ¡ play/mute a cada fragmento â€” isso travava e mutava o ESPN no meio.
    // SÃ³ limpa o timer de tela preta e deixa o MSE seguir.
    // NÃƒO limpa o blankTimer no LEVEL/FRAG_LOADED do live â€” o playlist recarrega
    // a cada segmento e resetava o timeout pra sempre (spinner infinito sem erro).
    // SÃ³ FRAG_BUFFERED (dado real) limpa.
    hls.on(Hls.Events.LEVEL_LOADED, () => {
      if (destroyed) return
    })
    hls.on(Hls.Events.FRAG_LOADED, () => {
      if (destroyed) return
      // Segmento baixado Ã© progresso: o circuito de nÃ£o-fatal volta a zero.
      hlsSoftFail = 0
    })
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      window.clearTimeout(blankTimer)
      hlsSoftFail = 0
      // Live: hls.js sÃ³ leva o currentTime pra borda no refresh do playlist
      // (atÃ© 20s parado no 0.0 â€” issue #4950). Se o 0.0 tÃ¡ longe da janela,
      // pula na hora pra borda igual o mpv (live_start_index=-1), sem mpv.
      if (live && !firstFragLogged) {
        try {
          const buffered = video.buffered
          if (buffered.length > 0) {
            const start = buffered.start(0)
            const end = buffered.end(buffered.length - 1)
            if (video.currentTime < start - 0.5 || end - video.currentTime > 4) {
              video.currentTime = Math.max(start, end - 1.5)
            }
          }
        } catch {
          // ignore
        }
      }
      if (!firstFragLogged) {
        firstFragLogged = true
        writeEngineMemory(url, 'hls')
        dbg('first-frag', { t: elapsed(), w: video.videoWidth, h: video.videoHeight })
      }
      // Se travou com buffer mas pausado, retoma sem mexer no som
      if (!video.paused) ensureUnmutedOnce(video)
      else playWithFallback(video)
    })
    // Anti-travamento jÃ¡ tratado pelo onStallNudge global (waiting/stalled).
    // Aqui sÃ³ limpa tela preta, sem recriar HLS.
    const onStall = () => {
      if (destroyed || !live) return
      window.clearTimeout(blankTimer)
    }
    video.addEventListener('waiting', onStall)
    video.addEventListener('stalled', onStall)
    const removeStall = () => {
      video.removeEventListener('waiting', onStall)
      video.removeEventListener('stalled', onStall)
    }
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (destroyed || !hls || !data.fatal) {
        // Loga nÃ£o-fatal pra diagnosticar spinner (manifest 403/404 aparece aqui antes de fatal)
        if (data && !data.fatal) {
          try {
            console.warn('[stplay][hls]', data.type, data.details, data.response?.code || data.networkDetails || '')
          } catch {
            // ignore
          }
          /*
           * DISJUNTOR de erro nÃ£o-fatal repetido.
           *
           * O caminho de retry contava SO erro fatal: `hlsRetry` so sobe no
           * `NETWORK_ERROR` fatal e no `MEDIA_ERROR`. Um `aborted` nÃ£o-fatal nÃ£o
           * entra em nenhuma das duas contagens â€” e era o que o painel deste
           * dono produzia, sem parar.
           *
           * Medido no log: 38 `networkError / aborted` em 35s, ritmo de ~1,3s,
           * e `MANIFEST_PARSED` nunca chegou. `hls.js` aborta a requisiÃ§Ã£o quando
           * reinicia o load; ele fazia isso, o contador nao subia, o `scheduleBlankCheck`
           * de 10s era rearmado a cada `startHls`, e a tela ficava em spinner
           * para sempre sem nunca cair no proximo candidato nem no proximo motor.
           *
           * `aborted` sozinho Ã© normal em live (troca de segmento, `startLoad`).
           * O que Ã© patolÃ³gico Ã© a RAJADA sem nenhum progresso: por isso o contador
           * sobe no nÃ£o-fatal e ZERA em qualquer sinal de vida (manifest parsed,
           * fragmento bufferizado, tempo correndo). Nesses casos o circuito fica
           * fechado e o streaming normal nunca Ã© interrompido.
           */
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hlsSoftFail += 1
            if (hlsSoftFail >= HLS_SOFT_FAIL_MAX && !isVideoRendering(video)) {
              dbg('hls-soft-trip', {
                t: elapsed(),
                erros: hlsSoftFail,
                details: String(data.details || ''),
              })
              hlsSoftFail = 0
              removeStall()
              failHls(
                live ? 'Live nÃ£o carregou â€” tentando prÃ³ximo motor' : 'Demorou para abrir o stream',
                `networkError repetido (${data.details || 'sem detalhe'})`,
              )
            }
          }
        }
        return
      }
      const detailCode =
        data.details ||
        (typeof data.response?.code === 'number' ? `http ${data.response.code}` : '')
      // 3 tentativas rÃ¡pidas e cai fora â€” spinner longo nÃ£o ajuda, o STUR assume
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && hlsRetry < 4) {
        hlsRetry += 1
        window.setTimeout(() => {
          if (destroyed || !hls) return
          try {
            hls.startLoad(live ? -1 : undefined)
          } catch {
            removeStall()
            failHls('Erro ao reproduzir o stream HLS', String(detailCode || 'rede'))
          }
        }, 200 * hlsRetry)
        return
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try {
          // 1Âª e 2Âª vez: sÃ³ recover, SEM trocar codec (trocar codec mutava o Ã¡udio no meio)
          if (hlsRetry < 2) {
            hlsRetry += 1
            hls.recoverMediaError()
            return
          }
          // SÃ³ troca codec 1x e sÃ³ se ainda nÃ£o trocou
          if (!audioSwapDone) {
            audioSwapDone = true
            hls.swapAudioCodec()
            hls.recoverMediaError()
            return
          }
        } catch {
          // fallback abaixo
        }
      }
      removeStall()
      dbg('hls-fatal', { t: elapsed(), type: data.type, details: String(detailCode || data.details || 'fatal') })
      failHls('Erro ao reproduzir o stream HLS', String(detailCode || data.details || 'fatal'))
    })
  }

  // Motor lembrado: canal com ffmpeg gravado OU host com 2+ canais no ffmpeg
  // vai direto no remux (~3-5s). Se falhar, volta pra cadeia cheia.
  let remembered = readEngineMemory(url)
  let hostFfmpeg = readHostFfmpegCount(url)
  const startHlsChain = () => {
    startHls(hlsCandidates[0])
  }

  const begin = () => {
    if (destroyed) return
    // Re-lÃª: o retry pode ter aprendido o motor na 1Âª tentativa
    remembered = readEngineMemory(url)
    hostFfmpeg = readHostFfmpegCount(url)
    dbg('begin', { t: elapsed(), url: redactUrl(url), hls: hlsCandidates.length, remembered, hostCount: hostFfmpeg })
    if (hlsCandidates.length > 0 && Hls.isSupported()) {
    if (remembered !== 'hls' && (remembered === 'ffmpeg' || hostFfmpeg >= 2)) {
      dbg('remembered-ffmpeg', { t: elapsed(), url: redactUrl(url), hostCount: hostFfmpeg })
      const useFresh = needFresh
      needFresh = false
      void (async () => {
        try {
          const w = window as unknown as {
            sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number, f?: boolean) => Promise<{ ok: boolean; url?: string }> } }
          }
          const res = await w.sturplay?.dev?.ffmpegWrap?.(url, 0, useFresh)
          if (destroyed) return
          if (res?.ok && res.url) {
            writeEngineMemory(url, 'ffmpeg')
            ffmpegVideoTried = true
            variantIndex = progressiveVariants.length
            loadProgressive(res.url)
            return
          }
        } catch {
          // cai pra cadeia cheia abaixo
        }
        if (!destroyed) startHlsChain()
      })()
      void onAudioTracks
      void onSubtitleTracks
      void controls
      return destroy
    }
    startHlsChain()
    void onAudioTracks
    void onSubtitleTracks
    void controls
    return destroy
  }

  if (isHlsManifest(url) && video.canPlayType('application/vnd.apple.mpegurl')) {
    loadProgressive(playSrc(toLiveHlsUrl(url)))
    void onAudioTracks
    void onSubtitleTracks
    void controls
    return destroy
  }

  // MP4/MKV direto (nÃ£o-HLS): usa a MESMA memÃ³ria de motor do ramo HLS. Sem
  // isto, todo reaberto refaz a cadeia progressiva inteira (variantes x
  // timeout ~40s de spinner) atÃ© chegar no remux que o host jÃ¡ gravou que
  // precisa. hostCount>=2 = host jÃ¡ provou que precisa de ffmpeg.
  if (remembered !== 'hls' && (remembered === 'ffmpeg' || hostFfmpeg >= 2)) {
    dbg('remembered-ffmpeg', { t: elapsed(), url: redactUrl(url), hostCount: hostFfmpeg, vod: true })
    const useFresh = needFresh
    needFresh = false
    void (async () => {
      try {
        const w = window as unknown as {
          sturplay?: { dev?: { ffmpegWrap?: (u: string, s: number, f?: boolean) => Promise<{ ok: boolean; url?: string }> } }
        }
        const res = await w.sturplay?.dev?.ffmpegWrap?.(url, 0, useFresh)
        if (destroyed) return
        if (res?.ok && res.url) {
          writeEngineMemory(url, 'ffmpeg')
          ffmpegVideoTried = true
          variantIndex = progressiveVariants.length
          loadProgressive(res.url)
          return
        }
      } catch {
        // cai pra cadeia progressiva abaixo
      }
      if (destroyed) return
      if (progressiveVariants[0]) loadProgressive(progressiveVariants[0])
      else finalError(formatVideoError(video))
    })()
    void onAudioTracks
    void onSubtitleTracks
    void controls
    return destroy
  }

  if (progressiveVariants[0]) loadProgressive(progressiveVariants[0])
  else finalError(formatVideoError(video))
  void onAudioTracks
  void onSubtitleTracks
  void controls
  return destroy
  }

  beginFn = begin
  begin()
  void onAudioTracks
  void onSubtitleTracks
  void controls
  return destroy
}
