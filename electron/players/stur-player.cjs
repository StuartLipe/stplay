/**
 * STUR — mpv embutido + proxy ffmpeg-static (modelo IPTV Player One).
 * Motor separado; não altera mpv-one, mpv-exe nem player interno.
 */
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const { forceKillPid, forceKillProc } = require('./mpv-kill.cjs')
const koffi = require('koffi')
const { screen } = require('electron')
// `net` acima é o módulo de sockets do Node. O preflight precisa do `net.fetch`
// do Electron, que respeita a sessão Chromium e o bypass de certificado.
const { net: electronNet } = require('electron')
const { findSturMpv } = require('../find-player.cjs')
const sturProxy = require('../stur-ffmpeg-proxy.cjs')
const { localPlayUrl, resolveRedirectUrl } = require('../stream-proxy.cjs')
const { vodUrlVariants } = require('./vod-url-variants.cjs')
const {
  shouldPreResolveRedirect,
  shouldTryHttpFallback,
  liveEdgeSeekArgs,
  liveStopWaitMs,
  liveConnReleaseMs,
  liveStreamLavfO,
} = require('./live-load-policy.cjs')
const { profileFor, diffProfile, commitApplied } = require('./playback-profile.cjs')
const hwndHelper = require('./hwnd-helper.cjs')
const log = require('./player-log.cjs')
const { isPlayableUrl } = require('./play-url.cjs')
const overlay = require('./overlay-window.cjs')
const { writeLine } = require('./ipc-write.cjs')

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000
const WS_EX_TOPMOST = 0x00000008
const SW_HIDE = 0
const SW_SHOWNA = 8
const HWND_TOP = 0
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040
const SWP_FRAMECHANGED = 0x0020

const winApi =
  process.platform === 'win32'
    ? (() => {
        const user32 = koffi.load('user32.dll')
        return {
          FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr, intptr, str16, str16)'),
          GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr, _Out_ uint32*)'),
          SetParent: user32.func('intptr __stdcall SetParent(intptr, intptr)'),
          SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr, int, intptr)'),
          GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(intptr, int)'),
          GetParent: user32.func('intptr __stdcall GetParent(intptr)'),
          EnableWindow: user32.func('bool __stdcall EnableWindow(intptr, bool)'),
          MoveWindow: user32.func('bool __stdcall MoveWindow(intptr, int, int, int, int, bool)'),
          ShowWindow: user32.func('bool __stdcall ShowWindow(intptr, int)'),
          SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr, intptr, int, int, int, int, uint32)'),
        }
      })()
    : null

/** @type {import('child_process').ChildProcess | null} */
let mpvProc = null
/** @type {import('net').Socket | null} */
let ipcSocket = null
let pipePath = ''
let pipeCounter = 0
/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null
/** @type {{ x: number; y: number; width: number; height: number } | null} */
let lastBounds = null
let parentHwnd = 0
let mpvHwnd = 0
let videoHidden = false
let lastPlacedKey = ''
let surfaceActive = false
let requestId = 0
let ipcBuf = ''
let running = false
let waitingFirstFrame = false
let fileLoaded = false
/** @type {number | null} */
let firstFrameBase = null
/** @type {ReturnType<typeof setInterval> | null} */
let raiseTimer = null
const CACHE_PAUSE_WAIT = 8
/** Ao vivo: start imediato (sem esperar buffer). VOD mantém cache-pause. */
let liveMode = false
/** @type {ReturnType<typeof setTimeout> | null} */
let liveShowTimer = null
/** Ao vivo: após 1º frame — ignora pause/buffer espúrios do mpv. */
let livePlaybackReady = false
/** Ao vivo: pause só quando o usuário pediu (overlay). */
let userPausedLive = false
// Mesma ideia para VOD: sem isso, pausar um filme emitia `pause` para o mpv mas
// a condição abaixo era insatisfazível (playbackStable já é true quando o
// handler roda, e o `else` exigia !playbackStable) — nada era emitido, o ícone
// continuava "tocando" com o quadro congelado.
let userPausedVod = false
// Tempo sem avanço de `time-pos` antes de considerar o live travado.
// 12s era curto demais: canais com buffer grande ficavam sem avanço por 15s+
// e o mpv fazia reload desnecessário. 30s cobre a maioria dos casos sem
// deixar o usuário esperando demais num canal realmente travado.
const LIVE_STALL_MS = 30000
// `ensureMpv` em voo — ver isBusy().
let starting = false
/** Após 1º frame: evita relayout/buffer espúrio (ao vivo e VOD). */
let playbackStable = false
let overlayPresented = false
/** VOD: espera mínima de buffer (segundos) — curto p/ start rápido; mid-play mantém cache. */
const VOD_CACHE_PAUSE_WAIT = 2

/** @type {Map<number, (msg: { data?: unknown }) => void>} */
const pendingRequests = new Map()

function isAvailable() {
  // Igual Player One no Windows: mpv nativo + HWND. ffmpeg só é fallback.
  return Boolean(findSturMpv() && winApi)
}

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player:event', payload)
  }
  try {
    overlay.sendEvent(payload)
  } catch {
    // ignore
  }
}

function emitFailed(reason) {
  waitingFirstFrame = false
  log.warn('stur', 'failed', { reason })
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  emit({ type: 'failed', reason })
}

/** Falha de spawn/adopt: limpa running e overlay pra não deixar tela preta presa. */
function failSpawn(reason) {
  log.warn('stur', 'spawn failed', { reason })
  running = false
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  return false
}

let cachePercent = 0
/** @type {ReturnType<typeof setInterval> | null} */
let bufferPollTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let durationPollTimer = null
/** @type {ReturnType<typeof setTimeout> | null} */
let loadWatchdog = null
let loadStartedAt = 0
let fileLoadedAt = 0
let knownDuration = 0

/** @type {string | null} */
let sourceUrl = null
/**
 * URL que foi de fato entregue ao mpv, em live.
 *
 * `sourceUrl` e a URL ORIGINAL pedida pelo usuario, e ela nao muda quando a
 * preflight leva o canal para o .ts. O log mostra o preco: o canal tocando era
 * `591495.ts`, e o `softReloadLive` recarregava `591495.m3u8` — a mesma que a
 * preflight ja tinha reprovado. O ciclo se repetia: m3u8 recusado -> .ts ->
 * soft reload do m3u8 -> preflight reprova de novo.
 *
 * Registrar o que foi realmente tocado deixa a recuperacao usar a variante
 * correta, sem mexer em `sourceUrl` (que identidade as cadeias de fallback usam
 * para lembrar o canal original).
 */
let livePlayUrl = null
let propertiesObserved = false
/** @type {Promise<boolean> | null} */
let ensurePromise = null
let currentLoadMode = 'direct'
let fallbackBusy = false
let lastStartSec = 0
/** Igual Player One: invalida watchdogs/recargas antigas ao trocar título. */
let loadGeneration = 0
/**
 * Ultimo valor confirmado de cada property de playback, por processo mpv.
 *
 * mpv mantem properties entre `loadfile`, mas NAO entre processos. Por isso o
 * memo e zerado sempre que um mpv novo e criado — senao o app acha que ja
 * configurou `cache-pause=false` num processo recem-nascido que nunca viu essa
 * property, e o canal abre com o perfil errado.
 */
let appliedProfile = new Map()
/** Quantos set_property o memo ja poupou. Entra no log de fim de sessao. */
let profileMemoSkipped = 0
let cacheTickSinceLoad = false
let cacheWaitRounds = 0
const LOAD_TIMEOUT_MS = 20_000
/** VOD em qualquer painel: 8s matava filme/série com 302/CDN. One espera ~25s. */
const VOD_LOAD_TIMEOUT_MS = 28_000
/** Continuar assistindo: seek demora — precisa de mais tempo antes de falhar. */
const VOD_RESUME_LOAD_TIMEOUT_MS = 32_000
/** Seek pós file-loaded (mais confiável que mpv --start em URLs remotas). */
let pendingVodSeekSec = 0

/**
 * Ordem igual ao IPTV Player One no Windows:
 * 1) URL direta no mpv (caminho principal)
 * 2) proxy HTTP passthrough (/stream ≈ /p do One)
 * 3) remux ffmpeg (/f ≈ /t do One) — só se os dois falharem
 * @param {'direct' | 'http' | 'ffmpeg'} mode
 */
function bumpLoadGeneration() {
  loadGeneration += 1
  cacheTickSinceLoad = false
  cacheWaitRounds = 0
  pendingVodSeekSec = 0
  clearLoadWatchdog()
  resolveEndFileWaiters()
  return loadGeneration
}

/** reload ao vivo: não esconder vídeo/overlay entre zaps rápidos. */
let nextLoadSoft = false
/** Zap 1 tela: ignora end-file error do canal antigo (não dispara fallback/failed). */
let releasingLiveSlot = false

/** stop() do mpv responde antes de fechar o TCP — waiters esperam o end-file. */
let endFileWaiters = []

function resolveEndFileWaiters() {
  const waiters = endFileWaiters
  endFileWaiters = []
  for (const resolve of waiters) resolve()
}

function waitForEndFile(timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      endFileWaiters = endFileWaiters.filter((item) => item !== finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    endFileWaiters.push(finish)
  })
}

async function applyReferrer(playUrl) {
  try {
    const origin = new URL(playUrl).origin
    if (origin && !/127\.0\.0\.1/i.test(playUrl)) {
      await sendIpc(['set_property', 'referrer', `${origin}/`])
    }
  } catch {
    // ignore
  }
}

/**
 * Preflight do manifesto HLS.
 *
 * Sem isto, um canal de origem Morta (ou oscilando) fazia o app esperar o
 * watchdog inteiro — 20 segundos medidos no log — antes de tentar o fallback
 * `.ts`, que carregava em 0,75s. O mpv só discoverre que o manifesto não
 * presta quando os segmentos começam a dar 404, e aí já passou meio minuto.
 *
 * Fazemos a mesma checagem antes, com timeout curto: busca o manifesto, e se
 * vier 404/erro ou demorar, cai direto no `.ts` em vez de esperar o mpv.
 *
 * Só para live: em VOD o caminho é outro e o watchdog já é curto.
 */
const PREFLIGHT_TIMEOUT_MS = 5000
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preflight timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Veredito por URL, não contador global.
 *
 * Antes era `preflightCount`: depois de 4 sondas, na sessão inteira, o preflight
 * desligava. Num painel onde SÓ ALGUNS canais têm origem boa, isso punia
 * justamente os piores — o canal lento pagava o watchdog de 20s sem nunca ser
 * sondado. Medido: manifesto do canal [ADULT] leva 14,7s para sair do painel, e
 * o app esperava 15,6s, enquanto canais mortos Respondem em 170ms.
 *
 * Com memo por URL: cada canal é sondado UMA vez. Os bons voltam em ~300ms e
 * nunca mais gastam uma requisição; os lentos/mortos ficam marcados e vão
 * direto para o `.ts` de toda vez. Custo: uma sondagem por canal_distinto.
 */
const preflightVerdict = new Map()
const PREFLIGHT_MEMO_MAX = 400

/**
 * Veredito da sondagem, em TRES estados - nao booleano.
 *
 *   true  = o painel respondeu e serviu manifesto com segmentos  -> use
 *   false = o painel RECUSOU (404/403, ou manifesto sem segmentos) -> va pro .ts
 *   null  = NAO SABEMOS: estourou o timeout, aborted, erro de rede
 *
 * Antes disso era booleano, e o `catch` caia em `healthy = false`. O log
 * mostra o estrago: `preflight falhou { error: 'This operation was aborted' }`
 * seguido de `preflight reprovou, indo direto para .ts`. Timeout virou veredito
 * NEGATIVO: um canal lento demais para responder no prazo foi carimbado como
 * morto e jogado no `.ts`, sem nunca ter sido testado de verdade.
 *
 * Isso importa porque canal lento nao e canal morto. O lento funciona, so
 * precisa de paciencia - e quem decide se ele abre e o proprio mpv, com o
 * watchdog de load. Forcar `.ts` por falta de resposta tira a chance do canal
 * de aparecer e ainda gasta uma segunda URL.
 *
 * O memo segue a distincao: so veredito DEFINITIVO e memoizado. Timeout nao e
 * carimbado para sempre, senao o canal lento fica condensado no `.ts` pelo
 * resto da sessao.
 */
async function liveManifestHealthy(url) {
  if (!liveMode || !/\.m3u8(\?|#|$)/i.test(url)) return true
  const memo = preflightVerdict.get(url)
  if (memo !== undefined) return memo

  let healthy = true
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS)
    try {
      // net.fetch resolve no CABEÇALHO. Ler o corpo precisa do MESMO timeout:
      // um painel que devolve 200 + headers e trava o corpo (comum atrás de
      // rate limiter) deixava esta função pendurada para sempre, sem watchdog
      // nenhum — armLoadWatchdog só roda depois, dentro de openUrl. O app
      // ficava em "Iniciando…" indefinidamente.
      const res = await withTimeout(
        electronNet.fetch(url, {
          method: 'GET',
          headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', Referer: `${new URL(url).origin}/` },
          bypassCustomProtocolHandlers: true,
          signal: ctrl.signal,
        }),
        PREFLIGHT_TIMEOUT_MS,
      )
      if (!res || !res.ok) {
        log.info('stur', 'preflight: manifesto recusado', { status: res ? res.status : 0, url: url.slice(-60) })
        healthy = false
      } else {
        const body = await withTimeout(res.text(), PREFLIGHT_TIMEOUT_MS)
        // Sem nenhum segmento (não só comentário), o manifesto não serve para nada.
        const hasSegment = body.split(/\r?\n/).some((line) => line && !line.startsWith('#'))
        if (!hasSegment) {
          log.info('stur', 'preflight: manifesto sem segmentos', { url: url.slice(-60) })
          healthy = false
        }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    // Timeout, abort ou rede caiu: isso e "nao sei", nao "morto". A decisao
    // fica com o watchdog de load, que roda com o mpv ja tentando a URL real.
    log.info('stur', 'preflight indefinido (nao e veredito negativo)', {
      error: error instanceof Error ? error.message : String(error),
      url: url.slice(-60),
    })
    return null
  }

  // So chega aqui veredito DEFINITIVO: o `null` ja saiu no catch acima. E o que
  // entra no memo — um timeout momentaneo nao pode condenar o canal pelo resto
  // da sessao, ele volta a ser sondado no proximo zape.
  if (preflightVerdict.size >= PREFLIGHT_MEMO_MAX) {
    const oldest = preflightVerdict.keys().next()
    if (!oldest.done) preflightVerdict.delete(oldest.value)
  }
  preflightVerdict.set(url, healthy)
  return healthy
}

async function loadStream(url, startSec, mode = 'direct', preflightDepth = 0) {
  const gen = loadGeneration
  clearLoadWatchdog()
  let playUrl = url

  // Sinal explicito de zape, no TOPO da funcao e nao depois da liberacao do
  // slot. A demolicao leva ate 1100ms (stop + waitForEndFile 700 + 400 de
  // socket); emitir aqui embaixo so acendia o spinner do overlay quando esse
  // tempo ja tinha passado. O overlay so acendia spinner antes do primeiro
  // quadro (`!hasPlayedRef.current`) e o `ready` so sai em `start()`, nunca no
  // `reload` do zape — entao sem este evento o usuario via 15 segundos de video
  // congelado sem nenhuma indicacao, com o app ja tendo declarado `playing`.
  if (liveMode) emit({ type: 'zap-start' })

  // Desarma o relogio de stall para o canal que vem entrar.
  //
  // O log mostra o estrago: `live sem avanco de time-pos { ms: 12567 }` disparava
  // em canais que NUNCA deram quadro — nao havia `first frame` antes, so
  // `loadfile ok`. No zape, `livePlaybackReady` e `lastLiveTimePosAt` ficam com
  // o valor do canal ANTERIOR (o `killMpv` nao roda no soft zap), entao o
  // detector olhava para o relogio velho, disparava, e o `softReloadLive`
  // reabria uma URL que nem comecou. Pior: isso custava um ciclo de 12s + o
  // watchdog de 20s antes de o app desistir.
  //
  // Aqui o relogio fica em 0, e o guard `> 0` do raise timer mantem a deteccao
  // desligada. Ela so rearma em `onFirstFrame`, quando o canal de fato comecou.
  // A partir dai, stall significa stall de verdade.
  if (liveMode) {
    lastLiveTimePosAt = 0
    liveStallRecoverCount = 0
  }

  // Descoberta de rede e demolicao local sao INDEPENDENTES, entao rodam juntas.
  //
  // Antes a ordem era: sondar o manifesto (rede, ~300ms num canal bom) -> so
  // depois soltar o slot de live (stop + waitForEndFile 700ms + 400ms de
  // espera de socket) = 1400ms em serie, com 300ms de tela parada em que
  // absolutamente nada acontecia no video.
  //
  // Agora a liberacao comeca no mesmo instante da sondagem. A sondagem acaba
  // escondida atras da liberacao: max(300, 1100) = 1100ms, nao 1400ms.
  // Num canal morto a sondagem falha em ~170ms e a liberacao ja esta em curso
  // de qualquer forma, entao nao ha regressao nesse caminho tambem.
  const needsPreflight = mode === 'direct' && liveMode && preflightDepth < 2
  const preflightP = needsPreflight ? liveManifestHealthy(url) : null

  // Solta o slot de live e para o arquivo atual. Roda em paralelo com a
  // sondagem e so e aguardado antes do loadfile.
  const releaseP = (async () => {
    const hadLiveFile = liveMode && fileLoaded
    if (hadLiveFile) {
      releasingLiveSlot = true
      // Sem reconnect o socket cai; senao a conta de 1 tela ainda ve o canal antigo.
      const releaseLavfO = liveStreamLavfO(false)
      const releaseRes = await sendIpc(['set_property', 'stream-lavf-o', releaseLavfO])
      // O memo do perfil precisa saber disso. Esta escrita muda a property FORA
      // do perfil, e sem o update o memo continuaria affirming que
      // `stream-lavf-o` esta com reconnect=1 (valor da live anterior). Aí o
      // diff do perfil pularia o comando por "ja esta aplicado" e o canal
      // abriria com reconnect=0 — que e exatamente o modo que segura o socket
      // velho e ocupa a unica tela. Sintoma: alguns canais nao abrem de jeito
      // nenhum depois de um zape, sem erro no log.
      if (releaseRes.ok !== false) appliedProfile.set('stream-lavf-o', releaseLavfO)
      log.info('stur', 'live slot release', { stopWait: liveStopWaitMs(), extra: liveConnReleaseMs() })
    }
    await sendIpc(['stop'])
    if (!hadLiveFile) return
    await waitForEndFile(liveStopWaitMs())
    if (gen !== loadGeneration) {
      releasingLiveSlot = false
      return
    }
    const releaseMs = liveConnReleaseMs()
    if (releaseMs > 0) await new Promise((r) => setTimeout(r, releaseMs))
    releasingLiveSlot = false
  })()

  if (needsPreflight) {
    const healthy = await preflightP
    if (gen !== loadGeneration) {
      await releaseP
      return null
    }
    if (healthy === false) {
      // Recusado de verdade. Timeout (`null`) NAO entra aqui: o canal lento
      // vai direto para a URL original e o mpv decide.
      const tsUrl = url.replace(/\.m3u8(\?|#|$)/i, '.ts$1')
      log.warn('stur', 'preflight reprovou, indo direto para .ts', { url: tsUrl.slice(0, 120) })
      // O veredito ja ficou memoizado por URL, entao da proxima vez este canal
      // vai direto ao .ts sem gastar outra sondagem. A profundidade de recursao
      // e o que limita o loop. A liberacao ja foi disparada acima; awaits aqui
      // para nao deixar um stop pendente quando a recursao recomecar.
      await releaseP
      return loadStream(tsUrl, startSec, 'direct', preflightDepth + 1)
    }
  }

  if (mode === 'http') {
    try {
      playUrl = await localPlayUrl(url)
    } catch (error) {
      log.warn('stur', 'http proxy failed', { error: error instanceof Error ? error.message : String(error) })
      await releaseP
      return null
    }
    if (gen !== loadGeneration) {
      await releaseP
      return null
    }
  } else if (mode === 'ffmpeg') {
    if (!sturProxy.isAvailable()) {
      await releaseP
      return null
    }
    playUrl = await sturProxy.wrapUrl(url, startSec)
    if (gen !== loadGeneration) {
      await releaseP
      return null
    }
    if (!playUrl) {
      await releaseP
      return null
    }
  } else if (mode === 'direct' && shouldPreResolveRedirect(url, liveMode)) {
    try {
      const resolved = await resolveRedirectUrl(url)
      if (gen !== loadGeneration) {
        await releaseP
        return null
      }
      if (resolved === null) {
        await releaseP
        return null
      }
      if (resolved && resolved !== url) {
        playUrl = resolved
        log.info('stur', 'resolved redirect', { to: resolved.slice(0, 120) })
      }
    } catch (error) {
      log.warn('stur', 'resolve redirect failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await releaseP
  if (gen !== loadGeneration) return null
  const softLiveZap = nextLoadSoft || (liveMode && livePlaybackReady)
  if (!softLiveZap) {
    waitingFirstFrame = true
    cachePercent = 0
    clearLiveShowTimer()
    if (!liveMode) hideVideo()
    reportBufferPercent(0, { forceActive: true })
  }
  fileLoaded = false
  fileLoadedAt = 0
  firstFrameBase = null
  if (!softLiveZap) clearLiveShowTimer()
  await applyPlaybackProfile(liveMode, { softZap: softLiveZap })
  const deferSeek = !liveMode && startSec > 0 && mode !== 'ffmpeg'
  if (deferSeek) {
    pendingVodSeekSec = startSec
    await sendIpc(['set_property', 'start', 'none'])
  } else if (startSec > 0 && mode !== 'ffmpeg') {
    pendingVodSeekSec = 0
    await sendIpc(['set_property', 'start', String(startSec)])
  } else {
    pendingVodSeekSec = 0
    await sendIpc(['set_property', 'start', 'none'])
  }
  await applyReferrer(playUrl)
  // Em live, esta e a URL que o mpv esta realmente recebendo — inclusive quando
  // a preflight desviou para o .ts. Registrar aqui e o unico ponto confiavel.
  if (liveMode) livePlayUrl = playUrl
  const res = await sendIpc(['loadfile', playUrl, 'replace'])
  releasingLiveSlot = false
  if (!res.ok) {
    log.warn('stur', 'loadfile failed', { mode, error: res.error, url: playUrl.slice(0, 120) })
    return null
  }
  log.info('stur', 'loadfile ok', { mode, live: liveMode, url: playUrl.slice(0, 120) })
  return playUrl
}

function clearLoadWatchdog() {
  if (loadWatchdog) {
    clearTimeout(loadWatchdog)
    loadWatchdog = null
  }
}

async function applyPendingVodSeek(gen = loadGeneration) {
  if (liveMode || pendingVodSeekSec <= 0 || gen !== loadGeneration) return
  const seekTo = pendingVodSeekSec
  pendingVodSeekSec = 0
  log.info('stur', 'vod resume seek', { seekTo })
  await sendIpc(['set_property', 'pause', true])
  await sendIpc(['seek', seekTo, 'absolute'])
  await sendIpc(['set_property', 'pause', false])
  armLoadWatchdog(gen)
}

function armLoadWatchdog(gen = loadGeneration) {
  clearLoadWatchdog()
  const waitMs = liveMode
    ? LOAD_TIMEOUT_MS
    : lastStartSec > 0 || pendingVodSeekSec > 0
      ? VOD_RESUME_LOAD_TIMEOUT_MS
      : VOD_LOAD_TIMEOUT_MS
  loadWatchdog = setTimeout(async () => {
    loadWatchdog = null
    if (!running || gen !== loadGeneration) return

    if (!fileLoaded) {
      // Estende se o buffer estiver enchendo (HTTPS/VOD lento no CDN).
      const maxRounds = 2
      if (cacheTickSinceLoad && cacheWaitRounds < maxRounds) {
        cacheWaitRounds += 1
        cacheTickSinceLoad = false
        log.info('stur', 'sem file-loaded mas buffer enchendo; aguardando mais')
        armLoadWatchdog(gen)
        return
      }
      if (sourceUrl && currentLoadMode !== 'ffmpeg' && !fallbackBusy) {
        log.warn('stur', 'no file-loaded before timeout, trying fallback', {
          mode: currentLoadMode,
          sourceUrl,
        })
        const ok = await tryFallbackLoad(sourceUrl, lastStartSec)
        if (gen !== loadGeneration) return
        if (ok) {
          armLoadWatchdog(loadGeneration)
          return
        }
      }
      log.warn('stur', 'no file-loaded before timeout', { sourceUrl })
      emitFailed('Stream não iniciou — verifique conexão ou URL')
      killMpv()
      return
    }

    if (!waitingFirstFrame) return

    if (cacheTickSinceLoad && cacheWaitRounds < (liveMode ? 2 : 1)) {
      cacheWaitRounds += 1
      cacheTickSinceLoad = false
      log.info('stur', 'file-loaded sem primeiro quadro mas buffer enchendo; aguardando mais')
      armLoadWatchdog(gen)
      return
    }

    if (fileLoadedAt > 0 && Date.now() - fileLoadedAt > (liveMode ? 15000 : 6000)) {
      log.warn('stur', 'forcing first frame after watchdog')
      void sendIpc(['set_property', 'pause', false])
      onFirstFrame()
      return
    }

    const [cacheTime, dur] = await Promise.all([
      getProperty('demuxer-cache-time'),
      getProperty('duration'),
    ])
    if (gen !== loadGeneration) return
    const progressing =
      (typeof cacheTime === 'number' && cacheTime > 0.4) ||
      (typeof dur === 'number' && dur > 0) ||
      cachePercent > 2
    if (progressing) {
      armLoadWatchdog(gen)
      return
    }
    log.warn('stur', 'buffer watchdog timeout', { cacheTime, dur, cachePercent })
    emitFailed('Buffer não encheu — tente outro player')
    killMpv()
  }, waitMs)
}

function percentFromCacheTime(secs) {
  if (secs <= 0) return 0
  const wait = liveMode ? 1 : VOD_CACHE_PAUSE_WAIT
  return Math.max(1, Math.min(99, Math.round((secs / wait) * 100)))
}

async function applyPlaybackProfile(live, opts = {}) {
  liveMode = live === true
  // Ver `playback-profile.cjs`: a tabela do perfil e o calculo do diff estao la
  // porque sao puros e testaveis. Aqui so orquestra o envio.
  const profile = profileFor(live, opts.softZap === true)
  const { fresh, stale } = diffProfile(profile, appliedProfile)
  if (stale.length > 0) profileMemoSkipped += stale.length

  // Um unico write no named pipe, em vez de 5-9 awaits sequenciais.
  const results = await sendIpcBatch(fresh.map((pair) => ['set_property', pair[0], pair[1]]))
  commitApplied(appliedProfile, fresh, results)
}

function clearLiveShowTimer() {
  if (liveShowTimer) {
    clearTimeout(liveShowTimer)
    liveShowTimer = null
  }
}

function armLiveShowSoon() {
  clearLiveShowTimer()
  if (!liveMode) return
  liveShowTimer = setTimeout(() => {
    liveShowTimer = null
    if (running && waitingFirstFrame && fileLoaded) onFirstFrame()
  }, 180)
}

function reportBufferPercent(pct, opts = {}) {
  const { forceActive } = opts
  const next = Math.max(cachePercent, Math.round(pct))
  cachePercent = Math.max(0, Math.min(100, next))
  if (liveMode && livePlaybackReady && !waitingFirstFrame && !forceActive) return
  if (!liveMode && playbackStable && !waitingFirstFrame && !forceActive) return
  const active =
    forceActive ?? (waitingFirstFrame ? cachePercent < 100 : cachePercent > 0 && cachePercent < 100)
  emit({ type: 'buffering', value: active, percent: cachePercent })
}

function emitBuffering(active, percent = cachePercent) {
  reportBufferPercent(percent, { forceActive: active })
}

function stopBufferPoll() {
  if (bufferPollTimer) {
    clearInterval(bufferPollTimer)
    bufferPollTimer = null
  }
}

function normalizeDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

function emitDuration(value) {
  const dur = normalizeDuration(value)
  if (dur <= 0) return
  if (knownDuration > 0) {
    if (Math.abs(knownDuration - dur) < 0.5) return
    // HLS/progressive pode reportar duração de segmento menor — não regredir no meio do filme
    if (dur < knownDuration * 0.92) return
  }
  knownDuration = dur
  emit({ type: 'duration', value: dur })
}

async function readDuration() {
  const names = ['duration', 'stream-duration', 'playlist-duration']
  for (let i = 0; i < names.length; i++) {
    const raw = await getProperty(names[i])
    const dur = normalizeDuration(raw)
    if (dur > 0) return dur
  }
  return 0
}

function stopDurationPoll() {
  if (durationPollTimer) {
    clearInterval(durationPollTimer)
    durationPollTimer = null
  }
}

function startDurationPoll() {
  stopDurationPoll()
  void (async () => {
    for (let i = 0; i < 24; i++) {
      if (!running || !ipcSocket || ipcSocket.destroyed) return
      const dur = await readDuration()
      if (dur > 0) {
        emitDuration(dur)
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  })()
  durationPollTimer = setInterval(async () => {
    if (!running || !ipcSocket || ipcSocket.destroyed || knownDuration > 0) {
      stopDurationPoll()
      return
    }
    const dur = await readDuration()
    if (dur > 0) emitDuration(dur)
  }, 2000)
}

function getProperty(name) {
  return new Promise((resolve) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      resolve(null)
      return
    }
    const id = ++requestId
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      resolve(null)
    }, 1200)
    pendingRequests.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg.data ?? null)
    })
    ipcSocket.write(JSON.stringify({ command: ['get_property', name], request_id: id }) + '\n')
  })
}

function startBufferPoll() {
  // Player One: % só via observe cache-buffering-state — sem progresso falso.
  stopBufferPoll()
}

function windowHwnd(win) {
  const buf = win.getNativeWindowHandle()
  if (!buf || buf.length < 4) return 0
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0))
  return buf.readUInt32LE(0)
}

function scaleFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1
  try {
    return screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor || 1
  } catch {
    return 1
  }
}

function findMpvHwnd(pid) {
  if (!winApi) return 0
  let cur = 0
  for (let i = 0; i < 64; i++) {
    cur = Number(winApi.FindWindowExW(0, cur, 'mpv', null))
    if (!cur) break
    const pidOut = [0]
    winApi.GetWindowThreadProcessId(cur, pidOut)
    if (pidOut[0] === pid) return cur
  }
  return 0
}

function applyMpvWindowStyle(hwnd, show) {
  if (!hwnd || !winApi) return
  let style = Number(winApi.GetWindowLongPtrW(hwnd, GWL_STYLE))
  style = (style | WS_CHILD | WS_CLIPSIBLINGS) & ~WS_POPUP & ~WS_CAPTION
  if (show) style |= WS_VISIBLE
  else style &= ~WS_VISIBLE
  winApi.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
  let ex = Number(winApi.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  ex = (ex & ~WS_EX_TOPMOST & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
  winApi.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex)
}

function adoptMpvWindow(pid, parent) {
  const hwnd = findMpvHwnd(pid)
  if (!hwnd) return 0
  applyMpvWindowStyle(hwnd, false)
  winApi.SetParent(hwnd, parent)
  winApi.EnableWindow(hwnd, false)
  winApi.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)
  winApi.ShowWindow(hwnd, SW_HIDE)
  winApi.MoveWindow(hwnd, -32000, -32000, 320, 180, false)
  videoHidden = true
  return hwnd
}

async function adoptMpv(pid, parent) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const hwnd = adoptMpvWindow(pid, parent)
    if (hwnd > 0) {
      mpvHwnd = hwnd
      log.info('stur', 'adopted', { hwnd, pid, parent, attempt })
      return true
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/**
 * Re-ancora o HWND no Electron. O mpv (vo=gpu) solta o parent pro Desktop
 * no first-frame — por isso o Gerenciador mostra "mpv" separado e o ST PLAY fica preto.
 */
function ensureEmbedded(show) {
  if (!mpvHwnd || !winApi) return false
  if (mainWindow && !mainWindow.isDestroyed()) {
    const hwnd = windowHwnd(mainWindow)
    if (hwnd) parentHwnd = hwnd
  }
  if (!parentHwnd) return false
  applyMpvWindowStyle(mpvHwnd, show)
  winApi.SetParent(mpvHwnd, parentHwnd)
  winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)
  return true
}

function hideVideo() {
  if (!mpvHwnd || !winApi) return
  // Sempre força hide — early-return com videoHidden deixava HWND preto cobrindo a UI no .exe
  try {
    ensureEmbedded(false)
  } catch {
    // ignore
  }
  try {
    winApi.EnableWindow(mpvHwnd, false)
    winApi.ShowWindow(mpvHwnd, SW_HIDE)
    winApi.MoveWindow(mpvHwnd, -32000, -32000, 320, 180, false)
  } catch {
    // ignore
  }
  videoHidden = true
  lastPlacedKey = ''
}

function isMpvDetached() {
  if (!mpvHwnd || !winApi || !parentHwnd) return false
  return Number(winApi.GetParent(mpvHwnd)) !== parentHwnd
}

function showVideo(bounds) {
  if (!surfaceActive || !mpvHwnd || !winApi || !bounds || bounds.width < 16) return
  const wasDetached = isMpvDetached()
  const wasHidden = videoHidden
  if (!ensureEmbedded(true)) return
  // Bounds completos — inset na barra deixava faixa preta “transparente” embaixo
  const s = scaleFactor()
  const x = Math.round(bounds.x * s)
  const y = Math.round(bounds.y * s)
  const w = Math.max(16, Math.round(bounds.width * s))
  const h = Math.max(16, Math.round(bounds.height * s))
  const placeKey = `${x},${y},${w},${h}`
  if (!wasHidden && !wasDetached && lastPlacedKey === placeKey) {
    winApi.EnableWindow(mpvHwnd, false)
    elevateOverlay()
    return
  }
  lastPlacedKey = placeKey
  winApi.EnableWindow(mpvHwnd, false)
  winApi.MoveWindow(mpvHwnd, x, y, w, h, true)
  if (wasHidden || wasDetached) {
    winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    winApi.ShowWindow(mpvHwnd, SW_SHOWNA)
    videoHidden = false
  }
  // Overlay sempre por cima do HWND — senão mouse/touch caem no mpv
  elevateOverlay()
}

function elevateOverlay() {
  if (!surfaceActive || !lastBounds) return
  try {
    overlay.syncBounds(lastBounds)
    overlay.bringToFront()
  } catch {
    // ignore
  }
}

function placeVideo(bounds) {
  if (!bounds || bounds.width < 16) return
  lastBounds = bounds
  if (waitingFirstFrame) {
    if (!liveMode && !videoHidden) hideVideo()
    if (!overlayPresented) syncOverlayLayout()
    return
  }
  showVideo(bounds)
}

function killMpv(opts = {}) {
  running = false
  waitingFirstFrame = false
  livePlaybackReady = false
  playbackStable = false
  overlayPresented = false
  userPausedLive = false
  userPausedVod = false
  fileLoaded = false
  fileLoadedAt = 0
  videoHidden = false
  lastBounds = null
  lastPlacedKey = ''
  if (sourceUrl) {
    try {
      sturProxy.closeFfmpegForUrl(sourceUrl)
    } catch {
      // ignore
    }
  }
  sourceUrl = null
  livePlayUrl = null
  firstFrameBase = null
  cachePercent = 0
  knownDuration = 0
  propertiesObserved = false
  ensurePromise = null
  currentLoadMode = 'direct'
  fallbackBusy = false
  stopBufferPoll()
  stopDurationPoll()
  pendingVodSeekSec = 0
  clearLoadWatchdog()
  clearLiveShowTimer()
  liveMode = false
  lastLiveTimePos = -1
  lastLiveTimePosAt = 0
  liveStallRecoverBusy = false
  liveStallRecoverCount = 0
  for (const [, cb] of pendingRequests) {
    try {
      cb({ error: 'killed' })
    } catch {
      // ignore
    }
  }
  pendingRequests.clear()
  if (raiseTimer) {
    clearInterval(raiseTimer)
    raiseTimer = null
  }
  // quit gracioso antes de destruir o socket
  if (ipcSocket && !ipcSocket.destroyed) {
    try {
      ipcSocket.write(JSON.stringify({ command: ['quit'] }) + '\n')
    } catch {
      // ignore
    }
  }
  try {
    ipcSocket?.destroy()
  } catch {
    // ignore
  }
  ipcSocket = null
  const proc = mpvProc
  mpvProc = null
  hideVideo()
  mpvHwnd = 0
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  // Devolve a promise do kill (ou null no caminho sync), para o chamador poder
  // aguardar a morte do processo sem bloquear o processo principal.
  return forceKillProc(proc, { sync: opts.sync === true })
}

function connectIpcOnce() {
  return new Promise((resolve) => {
    if (!pipePath) {
      resolve(false)
      return
    }
    const socket = net.connect(pipePath)
    const timer = setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(false)
    }, 3000)
    socket.once('connect', () => {
      clearTimeout(timer)
      ipcSocket = socket
      ipcBuf = ''
      socket.on('data', (chunk) => {
        ipcBuf += chunk.toString('utf8')
        const lines = ipcBuf.split('\n')
        ipcBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            handleIpcMessage(JSON.parse(trimmed))
          } catch {
            // ignore
          }
        }
      })
      socket.on('close', () => {
        if (ipcSocket === socket) ipcSocket = null
        if (running) emitFailed('STUR IPC disconnected')
      })
      resolve(true)
    })
    // `once` removed the listener after the first error. Named-pipe writes fail
    // asynchronously with EPIPE/ECONNRESET (mpv exiting mid-zap, killMpv
    // writing quit then the buffer being reused), so the SECOND error had no
    // listener and became an uncaught exception in the main process.
    socket.on('error', () => {
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve(false)
    })
  })
}

async function connectIpc() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await connectIpcOnce()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** Igual One: chrome do player no clique, antes do primeiro quadro. */
function presentLoadingShell() {
  if (!surfaceActive || !lastBounds || !mainWindow || mainWindow.isDestroyed()) return
  if (lastBounds.width < 64 || lastBounds.height < 64) return
  try {
    if (!overlayPresented) {
      overlay.show(mainWindow, lastBounds, { engine: 'stur' })
      overlayPresented = true
    } else {
      overlay.syncBounds(lastBounds)
      overlay.bringToFront()
      if (overlay.reshow) overlay.reshow()
    }
    overlay.sendUi({ action: 'boot' })
    overlay.sendUi({ action: 'show-controls' })
  } catch {
    // ignore
  }
}

function presentPlayback() {
  if (!surfaceActive || !lastBounds || !mainWindow || mainWindow.isDestroyed()) return
  if (lastBounds.width < 64 || lastBounds.height < 64) return
  showVideo(lastBounds)
  try {
    if (!overlayPresented) {
      overlay.show(mainWindow, lastBounds, { engine: 'stur' })
      overlayPresented = true
    } else {
      overlay.syncBounds(lastBounds)
      overlay.bringToFront()
      if (overlay.reshow) overlay.reshow()
    }
    overlay.sendUi({ action: 'hide-loading' })
    overlay.sendUi({ action: 'show-controls' })
  } catch {
    // ignore
  }
}

function syncOverlayLayout() {
  if (!lastBounds || !mainWindow || mainWindow.isDestroyed()) return
  try {
    overlay.syncBounds(lastBounds)
  } catch {
    // ignore
  }
}

let pausedForCache = false
/** Último time-pos visto (detecção de stall no ao vivo). */
let lastLiveTimePos = -1
let lastLiveTimePosAt = 0
let liveStallRecoverBusy = false
let liveStallRecoverCount = 0
/** Ao vivo: cache-pause preso — soft reload. */
let pausedForCacheSince = 0
let softReloadBusy = false

function noteLiveTimePos(pos) {
  if (!liveMode || typeof pos !== 'number') return
  if (pos !== lastLiveTimePos) {
    lastLiveTimePos = pos
    lastLiveTimePosAt = Date.now()
    liveStallRecoverCount = 0
  }
}

async function softReloadLive() {
  if (softReloadBusy || !running || !liveMode || !sourceUrl || !mainWindow || mainWindow.isDestroyed()) {
    return false
  }
  softReloadBusy = true
  pausedForCacheSince = 0
  liveStallRecoverCount = 0
  try {
    // A variante que estava TOCANDO, nao a original. Recarregar a original
    // devolvia o canal para a URL que a preflight ja tinha reprovado.
    const url = livePlayUrl || sourceUrl
    const bounds = lastBounds
    log.warn('stur', 'soft reload live', {
      url: url.slice(0, 100),
      original: url === sourceUrl ? undefined : sourceUrl.slice(0, 100),
    })
    nextLoadSoft = true
    bumpLoadGeneration()
    const opened = await openUrl(mainWindow, url, 0, bounds, { live: true })
    return Boolean(opened)
  } finally {
    softReloadBusy = false
  }
}

async function recoverLiveStall() {
  if (liveStallRecoverBusy || softReloadBusy || !running || !liveMode || !livePlaybackReady || userPausedLive) {
    return
  }
  if (!sourceUrl || pausedForCache) return
  liveStallRecoverBusy = true
  liveStallRecoverCount += 1
  lastLiveTimePosAt = Date.now()
  try {
    log.warn('stur', 'live stall recover', { count: liveStallRecoverCount })
    if (liveStallRecoverCount >= 2) {
      liveStallRecoverCount = 0
      await softReloadLive()
      return
    }
    await sendIpc(['set_property', 'pause', false])
  } finally {
    liveStallRecoverBusy = false
  }
}

function onFirstFrame() {
  if (!waitingFirstFrame) return
  waitingFirstFrame = false
  playbackStable = true
  if (liveMode) livePlaybackReady = true
  clearLiveShowTimer()
  stopBufferPoll()
  clearLoadWatchdog()
  reportBufferPercent(100, { forceActive: false })
  // O relógio de stall precisa começar aqui. `noteLiveTimePos` só atualiza
  // `lastLiveTimePosAt` quando o valor de time-pos MUDA, e o primeiro quadro
  // pode chegar por `dwidth` ou `cache-buffering-state` — nesse caminho nenhum
  // time-pos diferente viria, o campo ficava 0, e o guard `> 0` do raise timer
  // desligava a recuperação de stall para o resto daquela sessão.
  if (liveMode) lastLiveTimePosAt = Date.now()
  if (liveMode && !userPausedLive) void sendIpc(['set_property', 'pause', false])
  if (!liveMode) {
    // VOD: cache-pause no meio do filme pausava pra encher buffer — desliga após 1º frame
    pausedForCache = false
    void sendIpc(['set_property', 'cache-pause', false])
    void sendIpc(['set_property', 'cache-pause-initial', false])
    void sendIpc(['set_property', 'pause', false])
    void sendIpc(['set_property', 'demuxer-readahead-secs', 60])
    void sendIpc(['set_property', 'demuxer-max-bytes', '256MiB'])
    startDurationPoll()
  }
  // Mostra o overlay ANTES do playing — senão o React perde o evento e a bolinha fica
  presentPlayback()
  emit({ type: 'playing' })
  log.info('stur', 'first frame', { live: liveMode })
}

function handleIpcMessage(msg) {
  if (msg.request_id && pendingRequests.has(msg.request_id)) {
    pendingRequests.get(msg.request_id)(msg)
    pendingRequests.delete(msg.request_id)
    return
  }
  if (msg.event === 'property-change') {
    if (msg.name === 'time-pos' && typeof msg.data === 'number') {
      emit({ type: 'timeupdate', current: msg.data })
      noteLiveTimePos(msg.data)
      if (fileLoaded && waitingFirstFrame && (liveMode || !pausedForCache)) {
        if (firstFrameBase === null) firstFrameBase = msg.data
        else if (msg.data > firstFrameBase + 0.05) onFirstFrame()
      }
    }
    if (msg.name === 'duration') {
      emitDuration(msg.data)
    }
    if (msg.name === 'pause') {
      if (liveMode && livePlaybackReady) {
        if (userPausedLive) emit({ type: msg.data ? 'paused' : 'playing' })
        else if (!msg.data) emit({ type: 'playing' })
        return
      }
      // VOD estável: cache-pause não deve pausar nem mudar UI.
      // Consulta `userPausedVod`, não `userPausedLive`: essa última só vira
      // true quando liveMode é true, então no ramo de VOD ela é SEMPRE false e
      // `!userPausedLive` sempre era true — ou seja, o guard devolvia antes de
      // emitir justamente quando o usuário tinha pausado de propósito, e o
      // ícone voltava a ficar "tocando" com o quadro congelado. Era
      // exatamente o bug que o userPausedVod veio para fechar.
      if (!liveMode && playbackStable && !userPausedVod && pausedForCache) return
      if (waitingFirstFrame || !fileLoaded) {
        // Em VOD o cache-pause manda pause=true — não tratar como “usuário pausou”
        if (msg.data && !pausedForCache) emit({ type: 'paused' })
      } else {
        // `playbackStable` já é true depois do primeiro quadro, então exigir
        // !playbackStable tornava isto inalcançável. O que decide é se a pausa
        // partiu do usuário.
        if (userPausedVod || !playbackStable) emit({ type: msg.data ? 'paused' : 'playing' })
      }
    }
    if (msg.name === 'dwidth' && typeof msg.data === 'number' && msg.data > 0) {
      // VOD: mostra assim que há quadro decodificado (não espera cache-pause acabar)
      if (fileLoaded && waitingFirstFrame) onFirstFrame()
    }
    if (msg.name === 'cache-buffering-state' && typeof msg.data === 'number') {
      reportBufferPercent(Math.round(msg.data), { forceActive: waitingFirstFrame || !fileLoaded })
      if (liveMode && fileLoaded && waitingFirstFrame && msg.data >= 5) onFirstFrame()
      // VOD: ~10% já libera — 40% deixava spinner longo demais
      if (!liveMode && fileLoaded && waitingFirstFrame && msg.data >= 10) {
        void sendIpc(['set_property', 'pause', false])
        onFirstFrame()
      }
    }
    if (msg.name === 'paused-for-cache' && typeof msg.data === 'boolean') {
      pausedForCache = msg.data
      if (liveMode && livePlaybackReady) {
        emit({ type: 'buffering', value: msg.data, percent: cachePercent })
        if (!msg.data) pausedForCacheSince = 0
        return
      }
      if (!(playbackStable && !waitingFirstFrame)) {
        emit({
          type: 'buffering',
          value: liveMode ? waitingFirstFrame : msg.data || waitingFirstFrame,
          percent: cachePercent,
        })
      }
      if (fileLoaded && waitingFirstFrame && !msg.data) onFirstFrame()
    }
    if (msg.name === 'demuxer-cache-time' && typeof msg.data === 'number') {
      cacheTickSinceLoad = true
      if (liveMode && livePlaybackReady && !pausedForCache && msg.data > 0.2) {
        lastLiveTimePosAt = Date.now()
      }
      if (!playbackStable) armLoadWatchdog(loadGeneration)
    }
  }
  if (msg.event === 'file-loaded') {
    fileLoaded = true
    if (liveMode && livePlaybackReady) {
      log.info('stur', 'file-loaded live refresh', { live: true })
      lastLiveTimePosAt = Date.now()
      pausedForCache = false
      void (async () => {
        await sendIpc(['set_property', 'cache-pause', false])
        await sendIpc(['set_property', 'pause', false])
        emit({ type: 'playing' })
        presentPlayback()
      })()
      return
    }
    waitingFirstFrame = true
    firstFrameBase = null
    fileLoadedAt = Date.now()
    knownDuration = 0
    pausedForCache = false
    cacheTickSinceLoad = false
    cacheWaitRounds = 0
    if (!liveMode) hideVideo()
    if (!liveMode) startDurationPoll()
    armLoadWatchdog(loadGeneration)
    if (!liveMode && pendingVodSeekSec > 0) {
      void applyPendingVodSeek(loadGeneration)
    } else if (liveMode) {
      void sendIpc(['seek', ...liveEdgeSeekArgs()])
      armLiveShowSoon()
    } else {
      emit({ type: 'preview' })
      void sendIpc(['set_property', 'pause', false])
      clearLiveShowTimer()
      liveShowTimer = setTimeout(() => {
        liveShowTimer = null
        if (running && waitingFirstFrame && fileLoaded && !liveMode) {
          onFirstFrame()
        }
      }, 350)
    }
    log.info('stur', 'file-loaded', { live: liveMode })
  }
  if (msg.event === 'end-file') {
    fileLoaded = false
    resolveEndFileWaiters()
    if (msg.reason === 'eof') {
      if (liveMode && sourceUrl && !userPausedLive) {
        log.warn('stur', 'live eof — soft reload')
        void softReloadLive()
      } else {
        emit({ type: 'ended' })
      }
    } else if (msg.reason === 'stop' || msg.reason === 'quit' || msg.reason === 'redirect') {
      log.info('stur', 'end-file', { reason: msg.reason, sourceUrl })
    } else if (releasingLiveSlot) {
      log.info('stur', 'end-file during live slot release', { reason: msg.reason, sourceUrl })
    } else {
      log.warn('stur', 'end-file', { reason: msg.reason, sourceUrl, mode: currentLoadMode })
      const canFallback =
        sourceUrl &&
        msg.reason === 'error' &&
        currentLoadMode !== 'ffmpeg' &&
        currentLoadMode !== 'http-ts'
      if (canFallback) {
        void (async () => {
          const ok = await tryFallbackLoad(sourceUrl, lastStartSec)
          if (!ok) {
            emitFailed(
              liveMode
                ? 'Canal indisponível no momento (offline ou ainda não começou)'
                : 'Não foi possível abrir este título',
            )
          }
        })()
      } else {
        emitFailed(
          liveMode
            ? 'Canal indisponível no momento (offline ou ainda não começou)'
            : 'Não foi possível abrir este título',
        )
      }
    }
  }
}

function ipcCommandOk(msg) {
  return !msg?.error || msg.error === 'success'
}

function sendIpc(command) {
  return new Promise((resolve) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      resolve({ ok: false, error: 'ipc disconnected' })
      return
    }
    const id = ++requestId
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }
    }, 8000)
    pendingRequests.set(id, (msg) => {
      clearTimeout(timer)
      const ok = ipcCommandOk(msg)
      resolve({ ok, error: ok ? undefined : msg.error, data: msg.data })
    })
    ipcSocket.write(JSON.stringify({ command, request_id: id }) + '\n')
  })
}

/**
 * Envia varios comandos num unico write no named pipe.
 *
 * O IPC JSON do mpv le uma linha por comando, entao empilhar varias linhas num
 * `write()` funciona e corta o custo de ida-e-volta. O perfil de playback mandava
 * 5-9 `set_property` SEQUENCIAIS, cada um com seu timeout de 8s: no zape de live
 * eram 5 voltas completas do named pipe entre o clique e o `loadfile`, todas
 * serializadas, quase todas com os mesmos valores que a live anterior ja tinha
 * deixado.
 *
 * Cada comando mantem seu proprio `request_id`, entao a correlacao das respostas
 * continua correta — `pendingRequests` mapeia id por id, e o timeout aqui e um so
 * para o lote inteiro.
 */
function sendIpcBatch(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return Promise.resolve([])
  }
  if (!ipcSocket || ipcSocket.destroyed) {
    return Promise.resolve(commands.map(() => ({ ok: false, error: 'ipc disconnected' })))
  }
  if (commands.length === 1) return sendIpc(commands[0]).then((r) => [r])

  return new Promise((resolve) => {
    const results = new Array(commands.length).fill(null)
    const batchIds = []
    let remaining = commands.length

    const finish = () => {
      if (remaining > 0) return
      clearTimeout(timer)
      for (let i = 0; i < results.length; i += 1) {
        if (!results[i]) results[i] = { ok: false, error: 'timeout' }
      }
      resolve(results)
    }

    const timer = setTimeout(() => {
      for (let i = 0; i < batchIds.length; i += 1) {
        if (results[i]) continue
        pendingRequests.delete(batchIds[i])
        results[i] = { ok: false, error: 'timeout' }
        remaining -= 1
      }
      finish()
    }, 8000)

    let payload = ''
    for (let i = 0; i < commands.length; i += 1) {
      const id = ++requestId
      batchIds.push(id)
      pendingRequests.set(id, (msg) => {
        if (results[i]) return
        const ok = ipcCommandOk(msg)
        results[i] = { ok, error: ok ? undefined : msg.error, data: msg.data }
        remaining -= 1
        finish()
      })
      payload += JSON.stringify({ command: commands[i], request_id: id }) + '\n'
    }
    try {
      ipcSocket.write(payload)
    } catch {
      for (let i = 0; i < batchIds.length; i += 1) pendingRequests.delete(batchIds[i])
      remaining = 0
      finish()
    }
  })
}

function normalizeStartSec(startTime) {
  return typeof startTime === 'number' && startTime > 5 ? Math.floor(startTime) : 0
}

function observeProperties() {
  if (propertiesObserved || !ipcSocket || ipcSocket.destroyed) return
  propertiesObserved = true
  const props = [
    'time-pos',
    'duration',
    'pause',
    'dwidth',
    'cache-buffering-state',
    'paused-for-cache',
    'demuxer-cache-time',
  ]
  for (let i = 0; i < props.length; i++) {
    void sendIpc(['observe_property', i + 1, props[i]])
  }
}

async function tryFallbackLoad(url, startSec) {
  if (fallbackBusy || !running || !url) return false
  fallbackBusy = true
  try {
    const asTs = (u) => (/\.m3u8(\?|$)/i.test(u) ? u.replace(/\.m3u8(\?|$)/i, '.ts$1') : null)

    if (currentLoadMode === 'direct') {
      // Ao vivo: muitos painéis abrem melhor em MPEG-TS (.ts) do que em .m3u8 no mpv
      if (liveMode) {
        const tsUrl = asTs(url)
        if (tsUrl) {
          currentLoadMode = 'direct-ts'
          log.info('stur', 'live fallback → direct .ts')
          if (await loadStream(tsUrl, startSec, 'direct')) {
            armLoadWatchdog(loadGeneration)
            return true
          }
        }
        if (shouldTryHttpFallback(liveMode)) {
          currentLoadMode = 'http'
          if (await loadStream(url, startSec, 'http')) {
            armLoadWatchdog(loadGeneration)
            return true
          }
        }
      } else {
        const variants = vodUrlVariants(url).filter((item) => item !== url)
        for (const variant of variants) {
          log.info('stur', 'vod fallback → ext')
          if (await loadStream(variant, startSec, 'direct')) {
            sourceUrl = variant
            armLoadWatchdog(loadGeneration)
            return true
          }
        }
        currentLoadMode = 'http'
        log.info('stur', 'vod fallback → http proxy')
        if (await loadStream(url, startSec, 'http')) {
          armLoadWatchdog(loadGeneration)
          return true
        }
      }
    }

    if (currentLoadMode === 'direct-ts') {
      if (!shouldTryHttpFallback(liveMode)) return false
      currentLoadMode = 'http'
      if (await loadStream(url, startSec, 'http')) {
        armLoadWatchdog(loadGeneration)
        return true
      }
    }

    if (currentLoadMode === 'http') {
      if (liveMode) {
        return false
      }
      currentLoadMode = 'ffmpeg'
      if (await loadStream(url, startSec, 'ffmpeg')) {
        armLoadWatchdog(loadGeneration)
        return true
      }
    }
    return false
  } finally {
    fallbackBusy = false
  }
}

function buildMpvArgs(url) {
  let origin = ''
  const isHls = /\.m3u8(\?|$)/i.test(url || '')
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const args = [
    `--input-ipc-server=${pipePath}`,
    '--idle=yes',
    '--keep-open=yes',
    '--force-window=yes',
    '--geometry=320x180+20000+20000',
    '--no-border',
    '--osc=no',
    '--osd-level=0',
    '--osd-bar=no',
    '--osd-on-seek=no',
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    '--vo=gpu',
    '--hwdec=auto-safe',
    '--cache=yes',
    liveMode ? '--demuxer-max-bytes=96MiB' : '--demuxer-max-bytes=512MiB',
    liveMode ? '--demuxer-readahead-secs=8' : '--demuxer-readahead-secs=120',
    liveMode ? '--cache-pause-initial=no' : '--cache-pause-initial=yes',
    liveMode ? '--cache-pause-wait=1' : '--cache-pause-wait=8',
    liveMode ? '--cache-secs=8' : '--cache-secs=30',
    '--volume=100',
    '--user-agent=VLC/3.0.21 LibVLC/3.0.21',
    '--network-timeout=60',
    '--tls-verify=no',
    '--no-terminal',
  ]
  if (liveMode || isHls) {
    args.push('--demuxer-lavf-o=live_start_index=-1')
    args.push(`--stream-lavf-o=${liveStreamLavfO(true)}`)
  }
  if (origin && !/127\.0\.0\.1/i.test(url)) args.push(`--referrer=${origin}/`)
  return args
}

async function spawnMpvCore(win, bounds) {
  // Mata qualquer processo anterior ANTES de spawnar.
  //
  // `ensureMpv` so protege o caminho feliz (`if (isRunning()) return true`).
  // Depois de uma falha — `end-file error`, watchdog, canal fora do ar — o
  // `isRunning()` fica false, o proximo retry entra aqui e spawna OUTRO
  // processo sem derrubar o antigo. O mpv velho continua vivo com
  // `--keep-open=yes`, segurando o dispositivo de audio e um HWND filho.
  //
  // Medido: cinco cliques em "Tentar novamente" no mesmo canal morto
  // produziram mpv pid 15040, 16904, 15228, 1884 e 16252 — cinco processos
  // ao mesmo tempo. Eles competem pelo HWND pai, o video fica preto, a janela
  // perde o layout e o renderer fica sem resposta.
  if (mpvProc) {
    const stale = mpvProc
    killMpv()
    // `await`, nunca `sync: true`. O sync roda `execSync('taskkill', { timeout:
    // 3000 })`, que bloqueia o PROCESSO PRINCIPAL do Electron inteiro — a
    // janela congelava a cada abertura de canal, exatamente o "cliquei e a tela
    // travou". O `await` nao bloqueia: o taskkill vai em background e a promise
    // so resolve quando ele termina, entao o processo velho ja morreu antes de o
    // novo nascer (sem duplicata) e a UI continua respondendo.
    await forceKillProc(stale)
  }
  mainWindow = win
  if (bounds) lastBounds = bounds
  parentHwnd = windowHwnd(win)
  if (!parentHwnd) return failSpawn('no parent hwnd')

  hwndHelper.prepareParent(parentHwnd)

  const mpvPath = findSturMpv()
  pipePath = `\\\\.\\pipe\\stplay-stur-${process.pid}-${++pipeCounter}`
  const args = buildMpvArgs(sourceUrl || 'http://127.0.0.1/')

  try {
    mpvProc = spawn(mpvPath, args, {
      cwd: path.dirname(mpvPath),
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch (error) {
    return failSpawn(`spawn threw: ${error instanceof Error ? error.message : String(error)}`)
  }

  const pid = mpvProc.pid || 0
  const thisProc = mpvProc
  mpvProc.on('exit', () => {
    if (mpvProc !== thisProc) return
    if (!running) return
    emitFailed('STUR encerrou')
    killMpv()
  })

  const [ipcOk, adopted] = await Promise.all([connectIpc(), adoptMpv(pid, parentHwnd)])
  if (!ipcOk || !adopted) {
    log.warn('stur', 'ipc/adopt failed', { ipcOk, adopted })
    killMpv()
    return failSpawn('ipc or adopt failed')
  }

  observeProperties()
  startRaiseTimer()
  // Processo novo = memoria nova. O memo do perfil descreve o mpv que acabou de
  // morrer, entao tem de sumir junto: se nao, o primeiro loadfile num processo
  // recem-criado pula todos os `set_property` por "ja estar aplicado" e abre o
  // canal com o perfil do mpv anterior — que ele nunca viu.
  appliedProfile = new Map()
  if (!surfaceActive) hideVideo()
  return true
}

async function ensureMpv(win, bounds) {
  if (isRunning()) return true
  if (ensurePromise) return ensurePromise
  running = true
  surfaceActive = false
  ensurePromise = spawnMpvCore(win, bounds).finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

function setMainWindow(win) {
  mainWindow = win
}

function startRaiseTimer() {
  if (raiseTimer) return
  raiseTimer = setInterval(() => {
    if (!running || !surfaceActive || !mpvHwnd) return
    if ((waitingFirstFrame && !liveMode) || !lastBounds) {
      if (!liveMode) hideVideo()
      return
    }
    if (isMpvDetached()) {
      log.warn('stur', 'mpv detached — re-embedding')
      lastPlacedKey = ''
      showVideo(lastBounds)
      return
    }
    if (videoHidden) showVideo(lastBounds)
    if (liveMode && livePlaybackReady && lastBounds) elevateOverlay()
    // Recuperação de live travado. `recoverLiveStall` estava escrito e correto,
    // mas a única chamada possível foi comentada — e `lastLiveTimePosAt` ficou
    // com 6 escritas e zero leituras. Resultado: se o live congelasse (CDN
    // parou de mandar segmento, encoder travou), o mpv não emite `end-file`
    // numa conexão aberta e parada, o UI continuava mostrando "tocando", e o
    // usuário só se recoverse re-zapeando na mão.
    if (liveMode && livePlaybackReady && !userPausedLive && !pausedForCache && !liveStallRecoverBusy) {
      if (lastLiveTimePosAt > 0 && Date.now() - lastLiveTimePosAt > LIVE_STALL_MS) {
        log.warn('stur', 'live sem avanco de time-pos', { ms: Date.now() - lastLiveTimePosAt })
        void recoverLiveStall()
      }
    }
  }, 1500)
}

async function openUrl(win, url, startTime = 0, bounds = null, opts = {}) {
  const startSec = normalizeStartSec(startTime)
  lastStartSec = startSec
  liveMode = opts.live === true
  currentLoadMode = 'direct'
  const gen = bumpLoadGeneration()

  let playUrl = await loadStream(url, startSec, 'direct')
  if (gen !== loadGeneration) {
    nextLoadSoft = false
    return null
  }
  if (!playUrl && shouldTryHttpFallback(liveMode)) {
    playUrl = await loadStream(url, startSec, 'http')
    if (gen !== loadGeneration) {
      nextLoadSoft = false
      return null
    }
    if (playUrl) currentLoadMode = 'http'
  }
  // Ao vivo: One só faz loadfile direto — http/ffmpeg atrasam e falham neste painel
  if (!playUrl && shouldTryHttpFallback(liveMode)) {
    playUrl = await loadStream(url, startSec, 'ffmpeg')
    if (gen !== loadGeneration) {
      nextLoadSoft = false
      return null
    }
    if (playUrl) currentLoadMode = 'ffmpeg'
  }
  if (!playUrl || gen !== loadGeneration) {
    nextLoadSoft = false
    return null
  }

  nextLoadSoft = false
  armLoadWatchdog(gen)
  if (!liveMode) startBufferPoll()
  startRaiseTimer()
  if (bounds) lastBounds = bounds
  return { playUrl, mode: currentLoadMode, startSec }
}

async function start(win, url, startTime = 0, bounds = null, opts = {}) {
  if (!isAvailable()) {
    log.warn('stur', 'start rejected: mpv.exe missing')
    return { ok: false, error: 'STUR indisponível (resources/mpv/mpv.exe)' }
  }
  if (!win || win.isDestroyed()) {
    log.warn('stur', 'start rejected: window unavailable')
    return { ok: false, error: 'Janela indisponível' }
  }
  if (typeof url !== 'string' || !isPlayableUrl(url)) {
    log.warn('stur', 'start rejected: invalid url', { url: String(url).slice(0, 120) })
    return { ok: false, error: 'URL inválida' }
  }
  log.info('stur', 'start', { live: opts.live === true, startTime, url: String(url).slice(0, 120) })

  liveMode = opts.live === true
  livePlaybackReady = false
  playbackStable = false
  overlayPresented = false
  userPausedLive = false
  userPausedVod = false
  lastLiveTimePos = -1
  lastLiveTimePosAt = 0
  liveStallRecoverCount = 0

  if (isRunning()) {
    const fast = await reload(win, url, startTime, bounds, opts)
    if (fast?.ok) return fast
    killMpv()
  }

  bumpLoadGeneration()
  sourceUrl = url
  mainWindow = win
  surfaceActive = true
  lastBounds = bounds && bounds.width >= 64 && bounds.height >= 64 ? bounds : null
  waitingFirstFrame = true
  videoHidden = true
  fileLoaded = false
  firstFrameBase = null
  cachePercent = 0
  clearLiveShowTimer()
  reportBufferPercent(0, { forceActive: true })
  presentLoadingShell()

  const gen = bumpLoadGeneration()
  starting = true
  // try/finally é obrigatório: ensureMpv chama koffi e win32 (prepareParent,
  // adoptMpvWindow, windowHwnd) e qualquer um deles pode lançar. Sem o finally,
  // um throw deixava `starting === true` para sempre — isBusy() ficava true
  // eternamente e TODO hideSurfaces() passava a matar o motor, inclusive os
  // caminhos que só deviam esconder a UI.
  let ready = false
  try {
    ready = await ensureMpv(win, bounds)
  } finally {
    starting = false
  }
  if (!ready) {
    log.warn('stur', 'start failed: ensureMpv not ready')
    return { ok: false, error: 'Falha ao iniciar STUR (mpv)' }
  }
  // O usuário deu Back durante o `ensureMpv` (até ~10s). hideSurfaces() roda o
  // stop, que bumpara loadGeneration — mas só se perguntar por isBusy(), já que
  // isRunning() é false enquanto o HWND não foi adotado. Sem esta checagem o
  // mpv.exe ficava órfão, ainda decodificando o live, com o overlay de volta
  // na tela e o renderer reportando falha de start.
  if (gen !== loadGeneration) {
    log.warn('stur', 'start cancelado durante ensureMpv')
    killMpv()
    return { ok: false, error: 'cancelado' }
  }

  surfaceActive = true
  presentLoadingShell()
  emit({ type: 'ready' })

  const opened = await openUrl(win, url, startTime, bounds, opts)
  if (!opened) {
    log.warn('stur', 'start failed: openUrl returned null', { live: liveMode })
    killMpv()
    return { ok: false, error: 'Falha ao abrir stream no STUR' }
  }

  log.info('stur', 'started', {
    pid: mpvProc?.pid,
    hwnd: mpvHwnd,
    mode: opened.mode,
    live: liveMode,
    url: opened.playUrl.slice(0, 120),
  })
  return { ok: true, engine: 'stur' }
}

function isRunning() {
  return running && Boolean(ipcSocket && !ipcSocket.destroyed) && mpvHwnd > 0
}

/**
 * Verdadeiro enquanto `ensureMpv` está em voo (spawn + conectar IPC + adotar
 * HWND, até ~10s). Nesse intervalo `isRunning()` é FALSO — mpvHwnd ainda é 0 —
 * e qualquer chamador que use isRunning() para decidir se deve matar o
 * motor deixa um mpv.exe órfão.
 */
function isBusy() {
  return starting === true
}

async function reload(win, url, startTime = 0, bounds = null, opts = {}) {
  if (!isRunning()) return null
  if (!win || win.isDestroyed()) return null
  if (typeof url !== 'string' || !isPlayableUrl(url)) return null

  mainWindow = win
  sourceUrl = url
  liveMode = opts.live === true
  if (bounds && bounds.width >= 64 && bounds.height >= 64) {
    lastBounds = bounds
  }
  bumpLoadGeneration()
  const softLiveZap = liveMode && isRunning()
  nextLoadSoft = softLiveZap
  if (!softLiveZap) {
    livePlaybackReady = false
    playbackStable = false
    overlayPresented = false
    waitingFirstFrame = true
    reportBufferPercent(0, { forceActive: true })
  } else {
    waitingFirstFrame = false
  }
  userPausedLive = false
  userPausedVod = false
  surfaceActive = true
  knownDuration = 0
  stopDurationPoll()
  fileLoaded = false
  firstFrameBase = null
  if (!softLiveZap) cachePercent = 0
  clearLiveShowTimer()
  if (!softLiveZap) presentLoadingShell()

  const opened = await openUrl(win, url, startTime, bounds, opts)
  nextLoadSoft = false
  if (!opened) {
    // Zap cancelou a carga — não derrubar mpv/overlay (evita tela só com vídeo)
    if (softLiveZap && isRunning()) return { ok: true, noop: true }
    return null
  }

  if (softLiveZap) presentPlayback()

  log.info('stur', 'reloaded', { mode: opened.mode, url: opened.playUrl.slice(0, 120) })
  return { ok: true, engine: 'stur' }
}

async function warm(win) {
  if (!isAvailable() || !win || win.isDestroyed()) return { ok: false }
  if (isRunning()) return { ok: true, warmed: true }
  sourceUrl = 'http://127.0.0.1/'
  const ok = await ensureMpv(win, null)
  surfaceActive = false
  hide()
  return { ok, warmed: ok }
}

function abortActiveLoad() {
  bumpLoadGeneration()
  nextLoadSoft = false
  fallbackBusy = false
  softReloadBusy = false
  releasingLiveSlot = false
  pausedForCacheSince = 0
  waitingFirstFrame = false
  clearLoadWatchdog()
  clearLiveShowTimer()
  if (sourceUrl) {
    try {
      sturProxy.closeFfmpegForUrl(sourceUrl)
    } catch {
      // ignore
    }
  }
  if (ipcSocket && !ipcSocket.destroyed) {
    try {
      ipcSocket.write(JSON.stringify({ command: ['stop'] }) + '\n')
    } catch {
      // ignore
    }
  }
}

function hide() {
  abortActiveLoad()
  surfaceActive = false
  hideVideo()
  lastBounds = null
  lastPlacedKey = ''
  overlayPresented = false
  if (raiseTimer) {
    clearInterval(raiseTimer)
    raiseTimer = null
  }
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  return { ok: true }
}

function stop(opts = {}) {
  hide()
  // Devolve a promise do kill quando ele e assincrono, para o chamador
  // esperar o processo morrer sem bloquear o processo principal.
  const killed = killMpv(opts)
  return { ok: true, killed }
}

async function command(op, value) {
  if (!ipcSocket || ipcSocket.destroyed) return { ok: false }
  try {
    if (op === 'pause') {
      userPausedLive = liveMode
      userPausedVod = !liveMode
      await sendIpc(['set_property', 'pause', true])
    } else if (op === 'play') {
      userPausedLive = false
      userPausedVod = false
      await sendIpc(['set_property', 'pause', false])
    } else if (op === 'toggle' || op === 'toggle-pause') {
      if (liveMode) userPausedLive = !userPausedLive
      else userPausedVod = !userPausedVod
      await sendIpc(['cycle', 'pause'])
    } else if (op === 'seek' && typeof value === 'number') await sendIpc(['seek', value, 'absolute'])
    else if (op === 'volume' && typeof value === 'number') {
      await sendIpc(['set_property', 'volume', Math.round(Math.max(0, Math.min(100, value * 100)))])
    } else return { ok: false }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function setBounds(rect) {
  if (!rect) return { ok: false }
  placeVideo(rect)
  return { ok: true }
}

function refreshLayout() {
  if (!running || !mpvHwnd) return { ok: false }
  if ((waitingFirstFrame && !liveMode) || !lastBounds) {
    ensureEmbedded(false)
    return { ok: true }
  }
  showVideo(lastBounds)
  return { ok: true }
}

module.exports = {
  isAvailable,
  isRunning,
  isBusy,
  setMainWindow,
  start,
  reload,
  warm,
  hide,
  abortActiveLoad,
  stop,
  command,
  setBounds,
  refreshLayout,
}
