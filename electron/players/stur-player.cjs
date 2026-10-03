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
const normalizer = require('./hls-normalizer.cjs')
const { vodUrlVariants } = require('./vod-url-variants.cjs')
const {
  shouldPreResolveRedirect,
  shouldTryHttpFallback,
  loadModeOrder,
  liveStopWaitMs,
  liveConnReleaseMs,
  liveDemuxerLavfO,
  liveStartIndex,
  networkTimeoutSecs,
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
          IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr)'),
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
//
// calibração: o canal publica um segmento a cada 10s (TARGETDURATION=10), e
// entre um segmento e outro o `time-pos` fica parado por construção. Qualquer
// limiar menor que o intervalo de publicação mata canais vivos. A história
// deste número registra duas vezes em que isso aconteceu:
//
//   12000 -> 30000 : subiu achando que cobria "canal lento", e o log continuou
//                    mostrando o mesmo congelamento (ms: 12070 vs ms: 30524).
//   6000            : abaixo do TARGETDURATION. Disparam 3.6s antes do segmento
//                    Due, e o sintoma vira o ciclo "trava -> carrega -> volta".
//
// 20s dá 2x de folga sobre o intervalo de publicação, e ainda corta o pior caso
// de 60s pela metade. Os dois limites vivem juntos com
// `LIVE_SILENCE_FULL_CACHE_SECS`, que impede o disparo quando o buffer está
// cheio — porque aí o playhead na borda não é defeito, é live.
const LIVE_STALL_MS = 20000

/**
 * Quantas vezes tentar recuperar antes de desistir. 1, de propósito.
 *
 * A ordem antiga era:
 *   1º disparo -> `set_property pause false`  (no-op: o stream não está pausado)
 *   2º disparo -> softReloadLive() no MESMO processo
 *
 * O no-op custava um ciclo inteiro de espera, e o soft reload no mesmo processo
 * é justamente a operação que não funciona (ver `softReloadLive`). Agora a
 * primeira constatação já mata o mpv e reabre, porque reabrir com socket novo é
 * a única coisa que conserta.
 */
const LIVE_STALL_MAX_RECOVER = 1

/**
 * Detecção de SILÊNCIO — a mais importante das três, e a que não existia.
 *
 * `time-pos` é o SINTOMA. O demuxer estar bloqueado num socket morto é a CAUSA,
 * e ele se anuncia muito antes: `demuxer-cache-time` para de crescer.
 *
 * Medido no congelamento real: `demuxer-cache-time` congelado, `pause=no`,
 * `paused-for-cache=false`, `eof-reached=false`, e a conexão TCP do processo em
 * `Established` com 0 bytes/s. Três sinais de "parado" que valem exatamente zero
 * para o `time-pos`, e `paused-for-cache` é justamente a property que o
 * perfil antigo desligava.
 *
 * Com buffer de 30s, exigir 5s sem crescimento de cache é folgado: mesmo num
 * canal parado de verdade, cache-pause segura a posição e o buffer não enche.
 * O que estamos olhando é "o demuxer parou de COMER", não "não tem vídeo".
 * 5s parado é curto demais para declarar, e curto o bastante para o usuário não
 * perceber a diferença.
 */
const LIVE_SILENCE_MS = 20000

/**
 * Acima deste buffer congelado, o video esta PRONTO e o problema nao e rede.
 *
 * O log mediu 9.88s de video parado por 19.4s de relogio. Havia material
 * pronto e ninguem consumindo. Matar o processo nesse caso e pior do que nao
 * fazer nada: joga fora o buffer, reabre a conexao e recomeca o ciclo de 20s.
 *
 * 3s e folgado para separar os dois: canal de verdade sem dados drena o buffer
 * ate zero, e sobra video pronto quando o problema e apresentacao.
 */
const LIVE_PRESENTABLE_CACHE_SECS = 3
/**
 * Quantas vezes reancorar a superficie antes de abrir o processo de novo.
 *
 * 1: a primeira constatacao ja reabre. O reancorar e barato e costuma
 * resolver, porque o problema e apresentacao e nao dados. Se nao resolveu, a
 * segunda vez ja eopatia — e continuar tentando e o que produzia o laco de ~20s
 * sem fim.
 */
const LIVE_PRESENTABLE_MAX_RETRY = 1
/**
 * Avanco MINIMO do playhead para contar como tempo andando.
 *
 * O 	ime-pos do mpv tem ruido de float: oscila nos ultimos digitos mesmo
 * parado. Comparar por !== media jitter, nao avanco, e o relogio de stall
 * nunca crescia. Medido: 60s congelados em 26.399667 com 	imePosParadoMs travado
 * em ~1,8s, sem o detector perceber.
 *
 * 0,15s esta bem abaixo de qualquer avanco real (o painel publica a cada ~10s)
 * e bem acima do ruido.
 */
const LIVE_TIME_POS_MIN_STEP = 0.15
/**
 * Avanco MINIMO para zerar o contador de tentativas, bem abaixo do piso de
 * deteccao acima.
 *
 * Serve so para `liveStallRecoverCount = 0`, nao para decidir se o canal esta
 * travado. O `time-pos` do HLS ao vivo avanca por segmento e fica parado
 * entre eles; se o zerador usasse o mesmo piso de 0,15s, o contador nunca
 * zeraria entre dois segmentos num canal saudavel, o watchdog armaria, e o
 * `softReloadLive` reiniciaria a reproducao — o "repete a mesma frase" que a
 * pessoa viu.
 *
 * 0,01s = menos de um frame a 30fps, e muito acima do jitter de float do mpv
 * (ordem de 1e-6), entao nao reintroduz o bug que o piso maior corrigiu.
 */
const LIVE_TIME_POS_EPS = 0.01

/**
 * Buffer cheio + playback parado NÃO é congelamento — é a borda viva.
 *
 * O log do primeiro teste com este sensor mediu, e os dois números contam a
 * história inteira:
 *
 *   cacheTime: 58.813745   timePos: 58.824838   timePosMs: 5234
 *
 * `time-pos` e `demuxer-cache-time` são IGUAIS. O demuxer leu a janela HLS
 * inteira e o playhead está no fim dela — ou seja, grudado na borda, com zero
 * de folga, esperando o próximo segmento. Isso é o comportamento CORRETO de um
 * player de live, não uma falha.
 *
 * E o canal publica um segmento a cada 10s (TARGETDURATION=10). O primeiro
 * quadro foi 03:49:36.342 e o "congelamento" foi declarado 03:49:49.997:
 * 13.6s depois. Com folga de 5s, o detector disparou 3.6s ANTES do segmento
 * 다음 ser Due.
 *
 * Erro do mesmo tipo que o do network-timeout: um limiar calibrado sem olhar o
 * intervalo de publicação da origem. Um canal vivo é morto por esse número.
 *
 * Consequência: buffer cheio NUNCA reinicia o processo. Quem decide é o
 * `cache-pause` do mpv, que pausa e reaninha, e o usuário vê o indicador de
 * buffering por 1-3s enquanto o segmento chega. Isso é o comportamento normal
 * de live e é o que "suavidade" quer dizer aqui.
 *
 * Só buffer VAZIO e parado é problema de rede, e aí reiniciar o processo é o
 * remédio certo.
 */
const LIVE_SILENCE_FULL_CACHE_SECS = 10
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

/** Tenta a cadeia VOD inteira de novo com 5s (painel oscilando).
 * Devolve true se agendou (chamador não deve falhar ainda). */
function scheduleVodTimeRetry() {
  if (liveMode || !sourceUrl || vodTimeRetries >= STUR_VOD_MAX_TIME_RETRIES) return false
  vodTimeRetries += 1
  const gen = loadGeneration
  emit({ type: 'buffering', value: true, percent: 0, retry: vodTimeRetries, of: STUR_VOD_MAX_TIME_RETRIES })
  log.warn('stur', 'vod time retry', { try: `${vodTimeRetries}/${STUR_VOD_MAX_TIME_RETRIES}` })
  clearVodRetry()
  vodRetryTimer = setTimeout(() => {
    vodRetryTimer = null
    if (gen !== loadGeneration || !running) return
    vodTriedUrls = new Set()
    void openUrl(mainWindow, sourceUrl, lastStartSec, lastBounds, { live: false })
  }, STUR_VOD_RETRY_MS)
  return true
}
/** @type {ReturnType<typeof setTimeout> | null} */
let vodRetryTimer = null

function clearVodRetry() {
  if (vodRetryTimer) {
    clearTimeout(vodRetryTimer)
    vodRetryTimer = null
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
/** URL do PAINEL em live, separada da URL resolvida. O reload parte daqui. */
let livePanelUrl = null
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

/**
 * Quantas URLs ja foram tentadas para ESTE VOD, sem sucesso.
 *
 * Medido antes deste teto, no filme e na serie que o usuario reportou:
 *
 *   [10:58:23.295] loadfile ok    1607372.mp4
 *   [10:58:23.769] end-file error 1607372.mp4
 *   [10:58:23.770] vod fallback -> ext
 *   [10:58:24.232] loadfile ok    1607372.mkv
 *   [10:58:24.688] end-file error 1607372.mkv
 *   [10:58:24.688] vod fallback -> ext
 *   ... a cada ~460 ms, indefinidamente
 *
 * A causa NAO e o guard de generation (esse esta correto). E que `loadStream`
 * devolve `true` assim que o comando `loadfile` e aceito pelo IPC — o erro de
 * verdade so chega 400-500 ms depois, como `end-file error`. Entao o
 * `tryFallbackLoad` achava que tinha funcionado, voltava, e a proxima tentativa
 * usava `sourceUrl`, que ja tinha virado `.mkv`. O `.filter(item => item !== url)`
 * so filtrava a extensao corrente do inicio; depois disso as duas extensoes
 * continuavam no ciclo, uma contra a outra.
 *
 * Sem este contador o fallback e um `while (true)`: a tela fica em "carregando"
 * para sempre e nunca mostra erro.
 */
let vodTriedUrls = new Set()

/** Teto de URLs distintas por VOD. Acima disso o titulo esta indisponivel. */
const VOD_MAX_URL_TRIES = 5

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
/**
 * A URL de VOD responde, mas o arquivo NAO existe?
 *
 * Este painel tem o mesmo episodio cadastrado duas vezes, com IDs diferentes, e
 * so um dos dois tem arquivo de verdade. Medido em `Brave 10 [L]` (series_id
 * 44008), episodio 1:
 *
 *   /series/.../1607372.mp4  -> 200 text/html, corpo comeca com `<html>`
 *   /series/.../2187891.mp4  -> 200 video/mp4, bytes `00 00 00 20 66 74 79 70`
 *
 * O `1607372` responde 200 e `Content-Type: text/html`: e a pagina 404 do XUI.one
 * ("Debug Mode / notfound") vestida de sucesso. O mpv abre, pede o arquivo, leva
 * `<html>` para o demuxer, e morre com `end-file error` — sem nunca dizer que o
 * arquivo nao esta la.
 *
 * Sem esta sondagem, o `tryFallbackLoad` so descobria isso tentando `.mp4`, `.mkv`,
 * `.avi`, `.ts`, http e ffmpeg do MESMO ID morto: seis URLs, ~4,5 s, e o titulo
 * nunca abre. Com a sondagem, a recusa e imediata e o erro diz a verdade.
 *
 * Mesmo contrato de tres estados do preflight de live: `false` so quando o painel
 * respondeu e o corpo NAO e midia. Timeout/erro de rede devolvem `null` ("nao
 * sei") e nao condenam a URL — um servidor lento nao e um arquivo ausente.
 */
const VOD_HTML_PREFIX = /^\s*(<!doctype html|<html)/i

async function vodUrlHasMedia(url) {
  if (!/\.(mp4|mkv|avi|ts|mov|flv|webm|m4v)(\?|#|$)/i.test(url)) return true
  const memo = preflightVerdict.get(url)
  if (memo !== undefined) return memo

  let healthy = true
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS)
    try {
      const res = await withTimeout(
        electronNet.fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Lavf/60.16.100',
            Referer: `${new URL(url).origin}/`,
            Range: 'bytes=0-255',
          },
          signal: ctrl.signal,
        }),
        PREFLIGHT_TIMEOUT_MS,
      )
      const type = String(res.headers.get('content-type') || '')
      if (/text\/html/i.test(type)) {
        healthy = false
      } else {
        // Alguns servidores ignoram o Range e devolvem 200 com o corpo inteiro.
        // Ler 256 bytes e barato e é o que separa midia de pagina de erro.
        const peek = await res.text()
        if (VOD_HTML_PREFIX.test(peek)) healthy = false
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    log.info('stur', 'preflight de VOD indefinido (nao e veredito negativo)', {
      error: error instanceof Error ? error.message : String(error),
      url: url.slice(-60),
    })
    return null
  }

  if (preflightVerdict.size >= PREFLIGHT_MEMO_MAX) {
    const oldest = preflightVerdict.keys().next()
    if (!oldest.done) preflightVerdict.delete(oldest.value)
  }
  preflightVerdict.set(url, healthy)
  return healthy
}

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
    // Zera o relógio de silêncio pelo mesmo motivo: no zape os dois ficam com
    // o valor do canal ANTERIOR, e o detector dispararia antes de o canal novo
    // ter chance de encher o buffer de 30s.
    lastCacheTime = -1
    lastCacheTimeAt = 0
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
      // Nao escreve mais `stream-lavf-o` aqui. A ideia original era soltar o
      // socket velho para a conta de 1 tela ver o canal novo, mas essa property
      // NAO aceita a option: `reconnect` e do AVFormatContext, e o manual do
      // mpv diz que `stream-lavf-o` descarta option desconhecida "silently".
      // O comando voltava `success` e nada acontecia — e o memo do perfil era
      // atualizado com um valor que nunca teve efeito, o que ainda por cima
      // fazia o diff seguinte pular o reenvio por "ja esta aplicado".
      //
      // O que solta o slot e o `stop` abaixo: fecha o demuxer, o SO larga o
      // socket, e o end-file + os 400ms de respiro dao a origem tempo de
      // contar a tela como livre.
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

  if (mode === 'normalize') {
    // Playlist canonica por cima do painel. O painel nao publica HLS
    // canonico (medido: 24 respostas, 24 conjuntos de URL, zero sobreposicao), e
    // o demuxer HLS do ffmpeg identifica segmento pelo numero de sequencia — por
    // isso ele para de buscar e a imagem congela com `buffer 100%`.
    // Justificativa completa e medicao em `live-load-policy.cjs`.
    try {
      playUrl = await normalizer.canonicalUrl(url)
    } catch (error) {
      log.warn('stur', 'normalizador indisponivel', {
        error: error instanceof Error ? error.message : String(error),
      })
      await releaseP
      return null
    }
    if (gen !== loadGeneration) {
      await releaseP
      return null
    }
  } else if (mode === 'http') {
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
  // A URL do PAINEL, separada da resolvida. O reload tem que partir desta.
  //
  // Recarregar a partir de `livePlayUrl` alimentava o normalizador com a propria
  // saida: ele tratava a propria saida como painel e embrulhava de novo, uma
  // camada por recarga. Medido: `cacheTime=91143.696522`, `timePos=0`, e a URL
  // do reload era `http://127.0.0.1:PORT/m/aHR0cDovLzIyMDhhaHNn...` (o
  // base64 do proprio base64).
  if (liveMode && /^https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(url)) livePanelUrl = url
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
      if (liveMode) {
        // Live NAO ganha quadro falso. Esta era a linha que transformava um
        // canal sem conteudo em um canal "funcionando": onFirstFrame() emite
        // playing, marca livePlaybackReady e mostra a UI de video. O
        // usuario via os controles, o titulo do canal e uma tela preta —
        // precisamente a segunda captura.
        //
        // Em live, o quadro verdadeiro vem do mpv ou nao vem. Se chegou ate
        // aqui sem ele, o manifesto abriu e nao entregou segmento, e o certo e
        // contar a tentativa como má e ir para a recuperacao, que sabe
        // reabrir e — no fim — declarar "indisponivel".
        liveUnhealthyLoads += 1
        log.warn('stur', 'live sem quadro apos watchdog', {
          tentativas: liveUnhealthyLoads,
          max: LIVE_MAX_UNHEALTHY_LOADS,
          url: (livePlayUrl || sourceUrl || '').slice(0, 100),
        })
        waitingFirstFrame = false
        void recoverLiveStall('sem primeiro quadro')
        return
      }
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
  // Percentual 0→100 igual Smarters: mede demuxer-cache-time a cada 400ms
  // enquanto o 1º frame não chega. O observe de cache-buffering-state sozinho
  // quase nunca dispara (só quando o mpv pausa por cache) — o número ficava
  // parado e o véu mostrava spinner seco. Vale pra live, filme e série.
  stopBufferPoll()
  const gen = loadGeneration
  bufferPollTimer = setInterval(async () => {
    if (gen !== loadGeneration || !running || !waitingFirstFrame) {
      stopBufferPoll()
      return
    }
    try {
      const secs = await getProperty('demuxer-cache-time')
      if (gen !== loadGeneration || !running || !waitingFirstFrame) return
      if (typeof secs === 'number' && secs > 0) {
        reportBufferPercent(percentFromCacheTime(secs), { forceActive: true })
      } else {
        // Sem dado ainda: garante o véu com 1% em vez de tela preta seca.
        reportBufferPercent(1, { forceActive: true })
      }
    } catch {
      // próxima volta tenta de novo
    }
  }, 400)
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

/**
 * Procura a janela de video do mpv.
 *
 * O `FindWindowExW(0, ...)` original so enxergava janelas TOP-LEVEL. Com
 * `--wid=<pai>` isso passou a ser insuficiente: o manual diz que o mpv "creates
 * its own window and sets the wid window as parent", entao a janela nasce como
 * FILHA da janela do Electron e `FindWindowExW(0, ...)` nunca a encontrava.
 * Medido: `ipc/adopt failed { ipcOk: true, adopted: false }` em toda abertura
 * de canal, com o mpv vivo e o IPC conectado — o HWND existia, a busca que nao
 * via.
 *
 * Agora varre os filhos do pai primeiro (caminho ancorado) e so depois cai no
 * top-level (caminho sem `--wid`, onde a janela nasce solta).
 *
 * @param {number} pid
 * @param {number} [parent] HWND do pai, quando conhecido
 */
function findMpvHwnd(pid, parent) {
  if (!winApi) return 0
  const matches = (hwnd) => {
    const pidOut = [0]
    winApi.GetWindowThreadProcessId(hwnd, pidOut)
    return pidOut[0] === pid ? Number(hwnd) : 0
  }
  if (parent) {
    let child = 0
    for (let i = 0; i < 64; i++) {
      child = Number(winApi.FindWindowExW(parent, child, 'mpv', null))
      if (!child) break
      const hit = matches(child)
      if (hit) return hit
    }
  }
  let cur = 0
  for (let i = 0; i < 64; i++) {
    cur = Number(winApi.FindWindowExW(0, cur, 'mpv', null))
    if (!cur) break
    const hit = matches(cur)
    if (hit) return hit
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
  const hwnd = findMpvHwnd(pid, parent)
  if (!hwnd) return 0
  // NAO FAZ SetParent AQUI.
  //
  // Com `--wid=<pai>` na linha de comando, o mpv ja criou a janela com o pai
  // certo — medido: `hwnd=0x14061E parent=0x907D4` batendo com a janela do
  // Electron. O `SetParent` que existia aqui era o reparenting pos-facto do
  // caminho antigo, e era ele que deixava o `vo=gpu` com um swapchain D3D11
  // apontando para uma janela que ja tinha sido destruida: o demuxer seguia
  // enchendo buffer e o quadro nunca chegava na tela.
  //
  // `parent` continua na assinatura porque, sem `--wid` (fallback), ainda é
  // preciso ancorar.
  const realParent = Number(winApi.GetParent(hwnd))
  if (parent && realParent !== parent) {
    winApi.SetParent(hwnd, parent)
  }
  applyMpvWindowStyle(hwnd, false)
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
  // Rede de seguranca, nao o caminho normal: com `--wid` o pai ja esta certo e
  // esta comparacao nao executa nada. Ela existe para o fallback sem `--wid`,
  // onde a janela do mpv ainda pode ter nascido top-level.
  if (Number(winApi.GetParent(mpvHwnd)) !== parentHwnd) {
    winApi.SetParent(mpvHwnd, parentHwnd)
  }
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

/**
 * A superfície do vídeo está perdida?
 *
 * `isMpvDetached()` sozinho era insuficiente, e o snapshot do app travado prova
 * por quê: o HWND do mpv continuava com o pai CERTO — parentado no overlay, que
 * era o que `ensureEmbedded` tinha reancorado — e mesmo assim o vídeo estava
 * fora da tela, em -32000, com o overlay `iconic`. `GetParent()` dizia " tudo
 * certo" enquanto o usuário via um quadro congelado.
 *
 * Então a checagem é: pai errado, OU janela escondida, OU jogada no parking de
 * -32000. Os três são a mesma coisa na prática — ninguém está vendo o vídeo.
 */
function isSurfaceLost() {
  if (!mpvHwnd || !winApi) return false
  if (isMpvDetached()) return true
  let visible = false
  try {
    visible = Boolean(winApi.IsWindowVisible(mpvHwnd))
  } catch {
    visible = true
  }
  if (!visible) return true
  if (videoHidden) return true
  // `hideVideo()` estaciona em -32000 e marca videoHidden. A coordenada é a
  // assinatura: nenhum outro caminho do app escreve -32000.
  return lastPlacedKey.startsWith('-32000,')
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
  } else if (videoHidden) {
    /*
      `wasHidden` vem de uma copia lida ANTES do `ensureEmbedded`. Se o
      `ensureEmbedded` reancorar o pai, `isMpvDetached()` passa a falso e os
      dois flags caem juntos, mas a janela segue escondida: o `else if` pegava
      esse caso e mantinha `videoHidden` verdadeiro para sempre.

      E o estado inconsistente faz o `isSurfaceLost()` do `raiseTimer` continuar
      verdadeiro a cada tique, o que produzia o log repetido de "superficie de
      video perdida — reancorando" (136 vezes no log) sem nada mudar.
    */
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
  livePanelUrl = null
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
  lastLiveTimePosAtPos = -1
  lastLiveTimePosAt = 0
  lastCacheTime = -1
  lastCacheTimeAt = 0
  liveStallRecoverBusy = false
  liveStallRecoverCount = 0
  liveUnhealthyLoads = 0
  vodTimeRetries = 0
  clearVodRetry()
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

/**
 * Qual PROCESSO este socket atende.
 *
 * Cada `mpv` novo abre o seu proprio named pipe, entao o socket e a fronteira
 * natural entre "evento do processo velho" e "evento do processo atual". O
 * `killMpv` fecha o socket do velho ANTES do novo subir, mas o `end-file` do
 * velho ja foi enfileirado no `ipcBuf` e sai no proximo `data` — que pode
 * acontecer depois que o novo processo ja conectou.
 *
 * POR QUE ISTO E O PID, E NAO A `loadGeneration`:
 *
 * A primeira versao do guard comparava com `loadGeneration`, e isso QUEBROU o
 * VOD inteiro. Medido:
 *
 *   [10:38:57.953] end-file de carga antiga, ignorado  reason=error gen=56 atual=57
 *   [10:39:25.406] no file-loaded before timeout, trying fallback
 *   [10:39:25.407] vod fallback -> ext   (.mp4 -> .mkv)
 *   [10:39:43.9..] repete, 28 s por ciclo, para sempre
 *
 * `loadGeneration` conta CARGAS, nao processos. O fallback de VOD recarrega no
 * MESMO processo vivo: `loadStream` chama `bumpLoadGeneration()` e manda
 * `loadfile` pelo socket que ja estava conectado. Entao a generation do socket
 * ficava uma atras, e o `end-file error` do processo VIVO — que e exatamente o
 * sinal que dispara o proximo fallback — era descartado como "carga antiga".
 *
 * Sem o sinal, o fallback so avancava pelo timeout de 28 s, um ext por vez,
 * para sempre: filme e serie nunca carregavam. Era o "carregando dos filmes ta
 * demorando muito".
 *
 * O PID nao tem esse problema: muda quando o processo muda, e nao muda quando so
 * a carga muda.
 */
let ipcGeneration = -1

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
      // Carimba o socket com o PID que ele atende. Mudar de carga no mesmo
      // processo NAO muda este numero — so `spawn` novo muda.
      ipcGeneration = mpvProc && !mpvProc.killed ? mpvProc.pid : -1
      ipcBuf = ''
      socket.on('data', (chunk) => {
        ipcBuf += chunk.toString('utf8')
        const lines = ipcBuf.split('\n')
        ipcBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed)
            // Carimba a generation de quem enviou. O `handleIpcMessage`
            // descarta o que nao for da carga viva.
            if (parsed && typeof parsed === 'object') {
              parsed._stplayGeneration = ipcGeneration
            }
            handleIpcMessage(parsed)
          } catch {
            // ignore
          }
        }
      })
      socket.on('close', () => {
        // Só um socket que AINDA É o socket ativo pode derrubar a reprodução.
        //
        // `socket.destroy()` é assíncrono: o evento `close` chega depois. No
        // caminho de recuperação de live o processo é morto e reaberto na
        // sequencia, e o `start()` já voltou `running = true` quando o `close`
        // do socket VELHO chega. O guard antigo era só `if (running)`, então o
        // socket da geração anterior derrubava a reprodução que já estava
        // nascendo. O log mostra o crime com precisão de milissegundo:
        //
        //   03:46:51.862  live reload com processo novo
        //   03:46:51.878  start
        //   03:46:51.895  failed  { reason: 'STUR IPC disconnected' }   <- 33ms
        //
        // `ipcSocket === socket` é a pergunta certa: quando o socket novo já
        // conectou, o `ipcSocket` global é outro, e o `close` antigo não tem
        // autoridade nenhuma sobre a reprodução atual.
        const isCurrent = ipcSocket === socket
        if (isCurrent) ipcSocket = null
        if (running && isCurrent) emitFailed('STUR IPC disconnected')
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
    /*
     * O `show-controls` aqui e so para o renderer ter os controles acesos. Ele
     * NAO pode derrubar a janela para a barra enquanto o canal carrega: e o que
     * fazia a roda de `carregando...` aparecer colada no rodape em vez de no meio
     * do video. Quem fecha a tela cheia do loading e `playback-ready` /
     * `hide-loading`, em `presentPlayback`.
     */
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
/** Último `time-pos` que realmente contou como avanço (ver LIVE_TIME_POS_MIN_STEP). */
let lastLiveTimePosAtPos = -1
let lastLiveTimePosAt = 0
let liveStallRecoverBusy = false
let liveStallRecoverCount = 0
/** Ao vivo: cache-pause preso — soft reload. */
let pausedForCacheSince = 0
let softReloadBusy = false

/**
 * Tentativas de reabertura do MESMO canal sem o canal ficar saudável.
 *
 * O log mostrou o buraco: o app estava em `709056`, cujo manifesto volta 200 com
 * UM segmento e `MEDIA-SEQUENCE: 0` — canal morto que ainda não começou. O
 * `.ts` dele abre e fica pendurado entregando 2s de vídeo em 22s. Nenhum dos
 * dois produz vídeo, e nenhum dos dois dá `end-file error`, então o watchdog de
 * stall fazia o que sabia: reiniciava o processo. Para sempre. O usuário via a
 * bolinha de "carregando" parada, exatamente o sintoma reportado — e a UI nunca
 * tinha como sair disso, porque o estado nunca chegava em `failed`.
 *
 * Agora cada reabertura que não entrega um buffer real conta um fracasso, e no
 * terceiro o app desiste e mostra "canal indisponível". Recuperação serve para
 * um socket que caiu; não serve para um canal que não existe.
 */
let liveUnhealthyLoads = 0

/**
 * Buffer que um canal precisa ter para ser considerado saudável.
 *
 * Abaixo disso, o primeiro quadro que apareceu foi de um buffer de 2s que nunca
 * vai encher — o suficiente para o mpv declarar `file-loaded` e enganar o
 * `onFirstFrame`, e insuficiente para assistir.
 */
const LIVE_HEALTHY_CACHE_SECS = 5

/** Quantas aberturas unhealthy o canal aguenta antes de virar "indisponível". */
const LIVE_MAX_UNHEALTHY_LOADS = 3

/** Registro a saúde do canal assim que o primeiro quadro aparece. */
function noteLiveLoadHealth() {
  if (!liveMode) return
  // -1 = ainda nao chegou leitura de cache. O log provou que o guess aqui
  // custa caro: canal subiu sem buffer utilizavel { cacheTime: -1 } num
  // canal saudavel, com o contador subindo a cada zape ate o app declarar
  // "canal indisponivel" com o canal no ar. Nao-saber nao e evidencia contra.
  if (lastCacheTime < 0) return
  const healthy = lastCacheTime >= LIVE_HEALTHY_CACHE_SECS
  if (healthy) liveUnhealthyLoads = 0
  else liveUnhealthyLoads += 1
  if (!healthy) {
    log.warn('stur', 'canal subiu sem buffer utilizavel', {
      cacheTime: lastCacheTime,
      tentativa: liveUnhealthyLoads,
      max: LIVE_MAX_UNHEALTHY_LOADS,
    })
  }
}

/**
 * Detecção de SILÊNCIO: último `demuxer-cache-time` e quando mudou.
 *
 * É o sensor que pega o congelamento real. O `time-pos` é o sintoma, e para
 * depois. No congelamento medido: `demuxer-cache-time` congelado, `pause=no`,
 * `paused-for-cache=false`, `eof-reached=false`, e a conexão TCP do processo em
 * `Established` com 0 bytes/s. Três sinais de "parado" que valem zero para o
 * `time-pos` — e `paused-for-cache`, que diria exatamente o que houve, estava
 * desligada no perfil antigo.
 */
let lastCacheTime = -1
let lastCacheTimeAt = 0

function noteLiveCacheTime(secs) {
  if (!liveMode || typeof secs !== 'number') return
  if (secs !== lastCacheTime) {
    lastCacheTime = secs
    lastCacheTimeAt = Date.now()
  }
}

/** O demuxer está bloqueado num socket que não entrega nada? */
function isLiveDemuxerSilent() {
  if (!liveMode || !livePlaybackReady || userPausedLive) return false
  if (!fileLoaded || pausedForCache) return false
  if (lastCacheTimeAt === 0) return false
  return Date.now() - lastCacheTimeAt > LIVE_SILENCE_MS
}

/**
 * Na borda viva, o playhead anda mesmo com o relogio do demuxer parado.
 *
 * Este e o discriminador que faltava, e ele separa os dois casos que antes
 * eram tratados como o mesmo:
 *
 *   - BORDA VIVA: o demuxer esta no fim da janela esperando o proximo segmento.
 *     `time-pos` avanca. O canal esta saudavel, e matar o processo aqui produz o
 *     ciclo "trava -> carrega -> volta -> trava".
 *   - SOCKET MORTO: `time-pos` parado E relogio do demuxer parado. O demuxer
 *     esta bloqueado numa conexao que nao entrega byte. So uma conexao nova
 *     resolve; reancorar a superficie nao resolve nada.
 *
 * Medido no congelamento real: o mpv com `Established` para 186.233.119.14:80 e
 * 0 bytes/s, enquanto requisicao nova na mesma URL devolvia HTTP 200. Esse e
 * exatamente o socket que produz "buffer cheio e tempo parado".
 */
function isLiveEdgeAdvancing() {
  if (lastLiveTimePosAt === 0) return false
  return Date.now() - lastLiveTimePosAt <= LIVE_STALL_MS
}

/**
 * O demuxer travou E o playhead travou: conexao morta, precisa de socket novo.
 *
 * Antes disto nao existia. Os dois guards do raise timer faziam
 * `if (lastCacheTime >= LIVE_SILENCE_FULL_CACHE_SECS) return` — e como a janela
 * deste painel tem 6 segmentos de 11s (~60s), `lastCacheTime` ficava
 * permanentemente acima de 10. Ou seja: o watchdog era NAO exercido neste
 * painel, e um canal com socket morto ficava travado indefinido com o log
 * calmo. O sintoma era "travou e nao faz nada".
 */
function isLiveUpstreamDead() {
  if (!isLiveDemuxerSilent()) return false
  return !isLiveEdgeAdvancing()
}

function noteLiveTimePos(pos) {
  if (!liveMode || typeof pos !== 'number') return
  lastLiveTimePos = pos
  // O AVANCO TEM DE SER REAL, NAO QUALQUER DIFERENCA.
  //
  // A comparacao anterior era `pos !== lastLiveTimePos`. O `time-pos` do mpv tem
  // ruido de float: ele oscila nos ultimos digitos mesmo com o playhead parado,
  // entao `!==` era quase sempre verdadeiro e `lastLiveTimePosAt` se reatualizava
  // sem parar. Resultado: o relogio de "ha quanto tempo o tempo nao anda" media
  // JITTER, e nunca crescia.
  //
  // Medido, 60 segundos de congelamento que o detector nao viu:
  //   11:19:22  timePos=26.399667  timePosParadoMs=1733
  //   11:19:37  timePos=26.399667  timePosParadoMs=1767
  //   11:19:52  timePos=26.399667  timePosParadoMs=1804
  //   11:20:07  timePos=26.399667  timePosParadoMs=1838
  //   11:20:22  timePos=26.399667  timePosParadoMs=1875
  //
  // O tempo estava parado no MESMO valor por um minuto, e a idade do relogio
  // ficava travada em ~1,8s. `isLiveEdgeAdvancing()` respondia "esta avancando" e
  // o `isLiveUpstreamDead()` nunca armava. So que: um congelamento de 60s
  // passou batendo, e se recuperou sozinho.
  //
  // Agora o relogio so anda quando o playhead anda de verdade. O piso de 0,15s
  // esta bem abaixo de qualquer avanco real (o painel publica a cada ~10s) e bem
  // acima do ruido do float.
  if (Math.abs(pos - lastLiveTimePosAtPos) >= LIVE_TIME_POS_MIN_STEP) {
    lastLiveTimePosAtPos = pos
    lastLiveTimePosAt = Date.now()
    liveStallRecoverCount = 0
    return
  }

  /*
    AVANCO PEQUENO AINDA E AVANCO.

    O `time-pos` do HLS ao vivo NAO corre continuamente: ele avanca por
    segmento. Entre dois segmentos ele fica no mesmo valor por 8 a 12s, e o
    piso de `LIVE_TIME_POS_MIN_STEP` (0,15s) rejeita esse avanco intermediario
    como jitter.

    E o `liveStallRecoverCount = 0` vivia SO dentro do if. Num canal em que o
    playhead so se move de um salto a cada segmento, o contador nao era
    zerado NUNCA entre dois segmentos: acumulava, o watchdog armava em canal
    saudavel, e o `softReloadLive` reiniciava a reproducao do zero. O sintoma
    e exatamente o relatado: "roda liso e de repente repete a mesma frase",
    porque recarregar um live volta para o comeco do que ja tinha tocad.

    O piso aqui e menor de proposito: 1 frame a 30fps e 0,033s, entao qualquer
    avanco real passa, e o jitter de float do mpv (ordem de 1e-6) continua
    fora.
  */
  if (Math.abs(pos - lastLiveTimePosAtPos) >= LIVE_TIME_POS_EPS) {
    lastLiveTimePosAtPos = pos
    lastLiveTimePosAt = Date.now()
    liveStallRecoverCount = 0
  }
}

/**
 * Reabrir o live MATANDO o processo.
 *
 * Este é o ponto que decide se o congelamento some. A versão anterior aqui era
 * `openUrl()` no mesmo processo, e a medição mostra por que ela nunca curou:
 *
 *   O congelamento é um socket morto. Não é o mpv, não é a URL, não é o demuxer:
 *   é a conexão TCP que o processo segurava, em `Established`, com 0 bytes/s,
 *   apontando para uma instância de stream que a origem já tinha descartado.
 *
 *   `loadfile` no MESMO processo não abre socket novo. O ffmpeg reaproveita o
 *   keep-alive e manda o GET novo pelo mesmo tubo morto. Daí o ciclo de 72s
 *   se repetindo para sempre: 10s de vídeo, 60s de espera, reload, 10s de
 *   vídeo — e o socket continuava exatamente o mesmo.
 *
 *   `reconnect=1` não salva: reconnect só dispara quando a conexão QUEBRA. Um
 *   socket aberto que não entrega nada nunca quebra, nunca dá timeout, nunca
 *   vira `end-file error`. Fica ali, mudo, e o app não recebe evento nenhum.
 *
 * Matar o processo é o que fecha a conexão: o SO entrega o socket morto, a
 * origem libera a tela, e o mpv novo abre uma conexão nova — que medi rodando
 * 80s seguidos contra o mesmo canal.
 */
async function softReloadLive() {
  if (softReloadBusy || !running || !liveMode || !sourceUrl || !mainWindow || mainWindow.isDestroyed()) {
    return false
  }
  softReloadBusy = true
  pausedForCacheSince = 0
  liveStallRecoverCount = 0
  // URL do PAINEL primeiro: livePlayUrl e a saida do normalizador, e normalizar
  // ela de novo encadeia saidas (medido: cache de 91.143s com time-pos 0).
  const url = livePanelUrl || livePlayUrl || sourceUrl
  const win = mainWindow
  const bounds = lastBounds
  try {
    log.warn('stur', 'live reload com processo novo', { url: url.slice(0, 100) })
    // Matar ANTES de reabrir, e ESPERAR a morte. `killMpv` devolve a promise do
    // `forceKillProc` justamente para isso.
    //
    // Sem o await, o processo velho continuava vivo enquanto o novo nascia, e o
    // `ensureMpv` do novo batia no limite de 50 tentativas do `connectIpc`:
    //   03:46:51.878  start
    //   03:47:01.914  ipc/adopt failed   <- 10s depois, 50 x 200ms
    //   03:47:01.914  start failed: ensureMpv not ready
    // O mpv velho segurando o named pipe e o HWND pai faz o novo nunca abrir o
    // pipe dele. Isso somava ao bug do `close` acima e transformava a
    // recuperação em "não foi possível reproduzir o vídeo".
    await killMpv()
    nextLoadSoft = false
    const opened = await start(win, url, 0, bounds, { live: true })
    return Boolean(opened && opened.ok)
  } finally {
    softReloadBusy = false
  }
}

/**
 * Recuperação de live travado.
 *
 * `LIVE_STALL_MAX_RECOVER = 1`: a primeira constatação já reabre. A ordem
 * antiga era `set_property pause false` no primeiro disparo — no-op num stream
 * que não está pausado, custando um ciclo de espera inteiro antes de qualquer
 * ação real.
 *
 * @param {string} reason o que disparou: 'sem time-pos' ou 'demuxer silencioso'
 */
async function recoverLiveStall(reason) {
  if (liveStallRecoverBusy || softReloadBusy || !running || !liveMode || !livePlaybackReady || userPausedLive) {
    return
  }
  if (!sourceUrl || pausedForCache) return

  // Teto de tentativas. Um canal que subiu sem buffer utilizável duas vezes
  // followed não vai melhorar na terceira: está fora do ar. Reabrir o processo
  // indefinidamente é o que produzia a bolinha parada em "carregando" pra
  // sempre, sem nunca chegar em `failed`.
  if (liveUnhealthyLoads >= LIVE_MAX_UNHEALTHY_LOADS) {
    log.warn('stur', 'desistindo do canal', {
      tentativas: liveUnhealthyLoads,
      url: (livePlayUrl || sourceUrl || '').slice(0, 100),
    })
    emitFailed('Canal indisponível no momento (offline ou ainda não começou)')
    killMpv()
    return
  }

  liveStallRecoverBusy = true
  liveStallRecoverCount += 1
  lastLiveTimePosAt = Date.now()
  lastCacheTimeAt = Date.now()
  try {
    log.warn('stur', 'live stall recover', { count: liveStallRecoverCount, reason })

    // COM VIDEO BUFFERIZADO, MATAR O PROCESSO NAO E A RESPOSTA.
    //
    // O log mediu o caso: live sem dados com o buffer vazio { cacheTime: 9.88,
    // timePos: 9.96, timePosMs: 19407 }. Nove segundos e meio de video
    // prontos, parados ha dezenove, com o demuxer esperando e o decoder parado.
    // Nao faltava rede: faltava alguem puxar os quadros. Matar o mpv joga
    // fora esses 9.88s, reabre a conexao, perde a janela de segmentos e repete
    // o ciclo de 20s — que e exatamente o sintoma de rodar 20 segundos e
    // recomecar.
    //
    // Quem consome(video bufferizado) e o VO. A resposta certa e reancorar a
    // superficie e cutucar o presentation, que e barato e reversivel.
    if (lastCacheTime >= LIVE_PRESENTABLE_CACHE_SECS) {
      /*
        REAPRESENTAR E SO UMA TENTATIVA, NAO UM CAMINHO SEM FIM.

        O log mediu o ciclo: `reapresentando` com cacheTime 5.96 seguido de
        `live stall recover count=2` 21 s depois, com o MESMO cacheTime. O
        reancorar a superficie nao puxa quadro nenhum, entao o `raiseTimer`
        reavisa, o VO continua sem apresentar, e o ciclo se repete para sempre
        — que e o "fica em loop" que a pessoa viu no ao vivo.

        A correcao e contar esta tentativa como qualquer outra: ela ja
        incrementa `liveStallRecoverCount` no topo da funcao, e o teto logo
        abaixo (`>= LIVE_STALL_MAX_RECOVER`) manda para `softReloadLive`. Com o
        buffer cheio e o video ainda parado apos uma reapresentacao, abrir o
        processo de novo e o que traz os quadros de volta.
      */
      if (liveStallRecoverCount > LIVE_PRESENTABLE_MAX_RETRY) {
        log.warn('stur', 'reapresentar nao resolveu, reabrindo', {
          tentativas: liveStallRecoverCount,
          cacheTime: lastCacheTime,
          url: (livePlayUrl || sourceUrl || '').slice(0, 100),
        })
        liveStallRecoverCount = 0
        await softReloadLive()
        return
      }
      log.info('stur', 'reapresentando: ha video bufferizado, nao e rede', {
        cacheTime: lastCacheTime,
        tentativa: liveStallRecoverCount,
      })
      if (lastBounds) {
        lastPlacedKey = ''
        videoHidden = true
        showVideo(lastBounds)
      }
      await sendIpc(['set_property', 'pause', false])
      return
    }

    // Buffer vazio: aqui sim a rede nao entrega e processo novo resolve.
    if (liveStallRecoverCount >= LIVE_STALL_MAX_RECOVER) {
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
  // Mesmo relógio para o sensor de silêncio. Sem isto o `isLiveDemuxerSilent`
  // continuaria com o carimbo do canal ANTERIOR e dispararia na hora, durante o
  // warm-up do buffer, matando um canal que está começando.
  if (liveMode) lastCacheTimeAt = Date.now()
  // Julga a saúde do canal que acabou de subir. É aqui que se descobre que o
  // `file-loaded` veio de um manifesto de 1 segmento com 2s de buffer.
  if (liveMode) noteLiveLoadHealth()
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
      /*
        TRACE TEMPORARIO de rewind no ao vivo (STPLAY_TP_TRACE=1).

        O dono relata que o ao vivo "volta uns segundos de vez em quando". Nem
        reload (raro no log) nem o normalizador (sequencia propria monotonica)
        explicam. Este trace registra toda vez que o `time-pos` ANDA PARA TRAS
        mais de 1s, com o antes/depois — e sai sozinho sem a variavel.
      */
      if (
        process.env.STPLAY_TP_TRACE === '1' &&
        liveMode &&
        typeof lastLiveTimePos === 'number' &&
        lastLiveTimePos >= 0 &&
        msg.data < lastLiveTimePos - 1
      ) {
        log.warn('stur', 'time-pos VOLTOU', {
          de: Number(lastLiveTimePos.toFixed(2)),
          para: Number(msg.data.toFixed(2)),
          voltaSeg: Number((lastLiveTimePos - msg.data).toFixed(2)),
          cacheTime: lastCacheTime,
          cacheParadoMs: lastCacheTimeAt > 0 ? Date.now() - lastCacheTimeAt : -1,
          modo: currentLoadMode,
          janelaNormalizada: (() => {
            try {
              return normalizer.inspecionar(sourceUrl)
            } catch {
              return null
            }
          })(),
        })
      }
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
      noteLiveCacheTime(msg.data)
      // NÃO renova `lastLiveTimePosAt`. O código antigo fazia isso, e aí o
      // "stall de time-pos" só podia disparar quando o cache TAMBÉM parava de
      // crescer — ou seja, o detector já era um detector de silêncio
      // disfarçado, só que com 30s de atraso. Agora os dois relógios são
      // independentes e o log diz qual dos dois quebrou.
      if (!playbackStable) armLoadWatchdog(loadGeneration)
    }
  }
  if (process.env.STPLAY_TP_TRACE === '1' && msg.event === 'seek') {
    log.warn('stur', 'mpv SEEK (demuxer reposicionou sozinho)', {
      live: liveMode,
      timePos: typeof lastLiveTimePos === 'number' ? Number(lastLiveTimePos.toFixed(2)) : null,
    })
  }
  if (msg.event === 'playback-restart') {
    if (process.env.STPLAY_TP_TRACE === '1') {
      log.warn('stur', 'mpv playback-restart', {
        live: liveMode,
        timePos: typeof lastLiveTimePos === 'number' ? Number(lastLiveTimePos.toFixed(2)) : null,
      })
    }
  }
  if (msg.event === 'file-loaded') {
    fileLoaded = true
    if (liveMode && livePlaybackReady) {
      log.info('stur', 'file-loaded live refresh', { live: true })
      lastLiveTimePosAt = Date.now()
      lastCacheTimeAt = Date.now()
      pausedForCache = false
      // ARMA O WATCHDOG AQUI TAMBEM. Este return desligava a unica rede de
      // seguranca do caminho de soft-zap, e o log mediu o preco exato:
      //
      //   04:24:07.913  file-loaded live refresh
      //   04:26:44        2min37s depois, nada. nem watchdog, nem stall, nem
      //                   falha. so a tela preta com os controles
      //
      // O canal entregou um manifesto que abre e nao produz segmento nenhum:
      // 709056.m3u8 voltava 200 com UM segmento e MEDIA-SEQUENCE 0. O mpv
      // reporta file-loaded e nunca da quadro, nunca emite
      // demuxer-cache-time e nunca da end-file. Como o ramo de zape retornava
      // antes de armLoadWatchdog, nao sobrava timeout nenhum -- e
      // livePlaybackReady ja vinha true do canal anterior, entao o sensor de
      // silencio e o contador de saude, que dependem de quadro, tambem nao
      // tinham como rodar.
      waitingFirstFrame = true
      firstFrameBase = null
      fileLoadedAt = Date.now()
      armLoadWatchdog(loadGeneration)
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
      // SEM seek de "borda ao vivo". Era `[100, 'absolute-percent']` e medido
      // contra o painel real ele jogava o canal ~49s PARA TRAS: `time-pos`
      // caía de 50.9 para 1.99, porque 100% do manifesto é o segmento mais
      // VELHO da janela, não a borda. Pior, seek reinicia o demuxer, e o manual
      // do mpv diz que `cache-pause-initial` "also triggers when playback is
      // restarted after seeking" — então cada abertura de canal reentrava
      // tocando com o buffer vazio. `live_start_index=-1` já entrega a borda.
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
    /*
      END-FILE DO PROCESSO ANTIGO, CHEGANDO DEPOIS DO ZAP.

      Medido nesta sessao:

        04:56:17.228  end-file stop       2396229.m3u8   (canal A)
        04:56:22.431  start               2396229.m3u8   (mesmo canal, zap)
        04:56:22.780  end-file stop       2396226.m3u8   (canal B, ANTIGO)
        04:56:22.786  reloaded            2396226.m3u8   reinicia o canal ERRADO

      O `stop`/`error` do processo que MORREU chega some frames DEPOIS do
      `start` do novo. Este handler nao checa de qual processo o evento veio, entao
      tratava o evento velho como se fosse do canal atual: disparava
      `tryFallbackLoad` / `softReloadLive` e reiniciava a reproducao do canal que
      acabara de subir.

      O sintoma era o "repete 3 a 4 segundos e segue normal": o canal tocava,
      o end-file velho chegava, e o `reloaded` voltava o mesmo canal no inicio.
      A cada ~5 s. E o video pareceia congelado sem nunca dar erro.

      A guarda e o PID: o evento so age se veio do processo VIVO. Ver o
      comentario de `ipcGeneration` para por que `loadGeneration` nao serve aqui
      — usar ela descartava o `end-file error` do processo vivo e travava o
      fallback de VOD em ciclo de 28 s.
    */
    const evPid = msg._stplayGeneration
    const atualPid = mpvProc && !mpvProc.killed ? mpvProc.pid : -1
    const stale = typeof evPid === 'number' && evPid !== atualPid
    if (stale) {
      log.info('stur', 'end-file de processo morto, ignorado', {
        reason: msg.reason,
        pidDoEvento: evPid,
        pidVivo: atualPid,
        sourceUrl: (sourceUrl || '').slice(0, 90),
      })
      return
    }
    fileLoaded = false
    resolveEndFileWaiters()
    if (msg.reason === 'eof') {
      if (liveMode && sourceUrl && !userPausedLive) {
        // Mesmo teto: EOF de um canal que não entrega é sinal de fora do ar,
        // não de socket que caiu. Reabrir para sempre só repete a espera.
        if (liveUnhealthyLoads >= LIVE_MAX_UNHEALTHY_LOADS) {
          emitFailed('Canal indisponível no momento (offline ou ainda não começou)')
          killMpv()
          return
        }
        log.warn('stur', 'live eof — reabrindo', { tentativas: liveUnhealthyLoads })
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
        // Igual MPEG/Smarters ("reconnects in 5s (x/5)"): o overlay mostra
        // o contador. Vale pra live, filme e série — mesmo evento, mesmo texto.
        const retryOf = liveMode ? LIVE_MAX_UNHEALTHY_LOADS : VOD_MAX_URL_TRIES
        const retryN = liveMode ? liveUnhealthyLoads + 1 : vodTriedUrls.size + 1
        emit({ type: 'buffering', value: true, percent: 0, retry: retryN, of: retryOf })
        void (async () => {
          const ok = await tryFallbackLoad(sourceUrl, lastStartSec)
          if (!ok) {
            // Cadeia esgotada mas painel pode estar oscilando (404 agora, play
            // depois — medido no 2357481 que o MPEG abriu minutos depois). Em
            // VOD tenta a cadeia inteira de novo, 5x com 5s. Live não: live
            // tem o próprio ciclo de unhealthy/reload.
            if (!liveMode && sourceUrl && vodTimeRetries < STUR_VOD_MAX_TIME_RETRIES) {
              vodTimeRetries += 1
              const gen = loadGeneration
              emit({ type: 'buffering', value: true, percent: 0, retry: vodTimeRetries, of: STUR_VOD_MAX_TIME_RETRIES })
              log.warn('stur', 'vod time retry', { try: `${vodTimeRetries}/${STUR_VOD_MAX_TIME_RETRIES}` })
              clearVodRetry()
              vodRetryTimer = setTimeout(() => {
                vodRetryTimer = null
                if (gen !== loadGeneration || !running) return
                vodTriedUrls = new Set()
                void openUrl(mainWindow, sourceUrl, lastStartSec, lastBounds, { live: false })
              }, STUR_VOD_RETRY_MS)
              return
            }
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
  // Modo cru falhou: vira 'direct' pra cadeia de fallback existente
  // (variantes de extensão no VOD, .ts/http no live) valer igual pros dois.
  if (currentLoadMode === 'raw') currentLoadMode = 'direct'
  try {
    const asTs = (u) => (/\.m3u8(\?|$)/i.test(u) ? u.replace(/\.m3u8(\?|$)/i, '.ts$1') : null)

    if (currentLoadMode === 'normalize') {
      // Em live, NAO ha plano B. O `direct` neste painel nao e alternativa: e o
      // MESMO problema que o normalizer resolve, so mais devagar.
      //
      // Medido: caindo para `direct` num canal cujo encoder demora, o mpv encheu
      // 89.98s de cache e parou —
      //
      //   socket do demuxer morto
      //     cacheTime=89.9846   cacheParadoMs=90631
      //     timePos=90.030011   timePosParadoMs=20450
      //
      // O `timePos` colado no fim de um cache que nao cresce ha 90 segundos e a
      // assinatura classica: ~90 segundos de tela parada. E o `ffmpeg` usa o mesmo
      // demuxer HLS sobre a mesma playlist nao canonica, entao cai no mesmo
      // buraco.
      //
      // `normalize` e o unico caminho que funciona com playlist nao canonica, e
      // ele tambem serve bem playlist canonica (e so um intermediario a mais). Se
      // ele falha, o canal nao presta: o certo e falhar rapido e deixar o
      // renderer trocar o `stream_id`, que e o que o painel rotaciona.
      if (liveMode) {
        const info = normalizer.inspecionar(url)
        log.warn('stur', 'live sem plano B apos o normalizador', {
          publicados: info ? info.publicados : 0,
          janela: info ? info.janela.length : 0,
          motivo: info ? info.ultimaFalha : null,
          tentativas: info ? info.falhas : 0,
        })
        return false
      }
      currentLoadMode = 'direct'
      if (await loadStream(url, startSec, 'direct')) {
        armLoadWatchdog(loadGeneration)
        return true
      }
    }
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
        /*
         * So Variantes que ainda NAO foram tentadas, e com teto.
         *
         * O `vodTriedUrls` e o que fecha o ciclo: cada URL so entra no conjunto
         * uma vez, entao `.mp4` e `.mkv` nao ficam alternando para sempre. E o
         * teto garante que, mesmo com URLs novas aparecendo, o VOD desiste e
         * mostra erro em vez de girar em "carregando" ate o fim dos tempos.
         */
        if (vodTriedUrls.size >= VOD_MAX_URL_TRIES) {
          log.warn('stur', 'vod sem plano B — todas as URLs falharam', {
            tentadas: vodTriedUrls.size,
            ultima: url,
          })
          return false
        }
        const variants = vodUrlVariants(url).filter(
          (item) => item !== url && !vodTriedUrls.has(item),
        )
        for (const variant of variants) {
          if (vodTriedUrls.size >= VOD_MAX_URL_TRIES) break
          /*
           * Sonda ANTES de gastar uma carga. Sem isso, trocar `.mp4` por `.mkv`
           * nao adianta nada quando o ID esta morto no painel: todas as extensoes
           * do mesmo ID devolvem a mesma pagina 404 em HTML.
           */
          const temMidia = await vodUrlHasMedia(variant)
          if (temMidia === false) {
            log.info('stur', 'vod: URL sem midia, pulando', { tentativa: vodTriedUrls.size + 1, url: variant })
            vodTriedUrls.add(variant)
            continue
          }
          vodTriedUrls.add(variant)
          log.info('stur', 'vod fallback → ext', { tentativa: vodTriedUrls.size, url: variant })
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
        // O proxy virou o caminho PRIMARIO no live (`loadModeOrder`), entao
        // precisa ter para onde cair. Antes ele era o ultimo da fila e podia
        // simplesmente desistir; agora uma falha dele derrubaria o canal sem
        // tentar o `direct` — o proxy viraria ponto unico de falha.
        //
        // O live continua preferindo o proxy (e nao o contrario), so deixa de
        // depender dele.
        currentLoadMode = 'direct'
        log.info('stur', 'live fallback → direct (proxy falhou)')
        if (await loadStream(url, startSec, 'direct')) {
          armLoadWatchdog(loadGeneration)
          return true
        }
        currentLoadMode = 'ffmpeg'
        if (await loadStream(url, startSec, 'ffmpeg')) {
          armLoadWatchdog(loadGeneration)
          return true
        }
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

/**
 * Argumentos do mpv.
 *
 * @param {string} url
 * @param {number} [wid] HWND do pai. Quando informado, o mpv ANCORA SOZINHO:
 *   o manual diz que mpv always creates its own window, and sets the wid
 *   window as parent, e que a janela will always be resized to cover the
 *   parent window fully.
 *
 *   Isso substitui o caminho antigo — spawnar com --force-window=yes, achar a
 *   janela com FindWindowEx e aplicar SetParent depois. O reparenting
 *   pos-facto e o que quebrava: a janela nasce top-level, o o=gpu monta o
 *   swapchain D3D11 para aquela janela, e so depois ela e reparentada. O VO
 *   fica com um swapchain de janela que nao existe mais, e o quadro para de
 *   chegar na tela enquanto o demuxer segue enchendo buffer.
 *
 *   Medido com o caminho suportado, pai = janela do Electron:
 *     hwnd=0x14061E  parent=0x907D4  visivel=True  titulo=709057.m3u8 - mpv
 *   O pai bate com a janela do Electron, o mpv criou a janela e setou o pai
 *   sem intervencao. O app so posiciona com MoveWindow depois.
 *
 * @param {number} [options.cachePauseInitial] override de cache-pause-initial
 */
function buildMpvArgs(url, wid = 0) {
  let origin = ''
  const isHls = /\.m3u8(\?|$)/i.test(url || '')
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const anchored = Number.isFinite(wid) && wid > 0
  const args = [
    `--input-ipc-server=${pipePath}`,
    '--idle=yes',
    '--keep-open=yes',
    // Com `--wid`, o mpv gerencia a propria janela e a ancora no pai, mas SOB
    // UMA CONDIÇÃO: ele só cria a janela do VO quando há vídeo. Como o app
    // adota a janela no spawn, ANTES de mandar o arquivo, isso travava o
    // Adopt: medido `ipc/adopt failed { ipcOk: true, adopted: false }` e
    // `spawn failed: ipc or adopt failed` em toda abertura de canal — o
    // findMpvHwnd voltava 0 porque o mpv ainda não tinha janela nenhuma.
    //
    // O `--force-window=immediate` resolve: o manual diz que `yes` cria a janela
    // "only after initialization", e `immediate` cria antes. O `--geometry` não
    // entra aqui porque com wid a janela "will always be resized to cover the
    // parent window fully".
    //
    // Sem wid (fallback), os dois antigos voltam: ai o mpv cria a janela
    // top-level e precisa de tamanho inicial e de `--force-window` para abrir
    // janela antes de haver video.
    ...(anchored
      ? [`--wid=${wid}`, '--force-window=immediate']
      : ['--force-window=yes', '--geometry=320x180+20000+20000']),
    '--no-border',
    '--osc=no',
    '--osd-level=0',
    '--osd-bar=no',
    '--osd-on-seek=no',
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    // gpu-next: 4K DV/HDR abre (tonemapping via libplacebo). O vo=gpu antigo
    // não decodifica Dolby Vision e o filme morria em end-file error.
    '--vo=gpu-next',
    '--hwdec=auto',
    '--hdr-compute-peak=yes',
    '--tone-mapping=auto',
    '--cache=yes',
    liveMode ? '--demuxer-max-bytes=96MiB' : '--demuxer-max-bytes=512MiB',
    liveMode ? '--demuxer-readahead-secs=8' : '--demuxer-readahead-secs=120',
    liveMode ? '--cache-pause-initial=no' : '--cache-pause-initial=yes',
    liveMode ? '--cache-pause-wait=1' : '--cache-pause-wait=8',
    /*
      EXPERIMENTO (volta-segundos no live): cache de 8s para 30s.

      Hipotese: com `cache-secs=8` e segmento de 10s/3.5MB, qualquer
      oscilacao da rede esvazia o cache, o mpv emite `playback-restart` e
      zera o `time-pos` — imagem e audio voltando juntos. Se com 30s o VOLTOU
      sumir ou espacar, a causa e fome de buffer e o numero fica.
    */
    liveMode && process.env.STPLAY_DEEP_CACHE === '1' ? '--cache-secs=30' : liveMode ? '--cache-secs=8' : '--cache-secs=30',
    '--volume=100',
    '--user-agent=VLC/3.0.21 LibVLC/3.0.21',
    // 10s no live, 60s no VOD. O valor importava: um socket aberto que não
    // entrega byte NUNCA quebra, então reconnect não dispara e o ffmpeg não dá
    // erro. O timeout de leitura é o único mecanismo que fecha isso, e a 60s
    // ele segurava um minuto de tela parada antes de reagir.
    `--network-timeout=${networkTimeoutSecs(liveMode)}`,
    '--tls-verify=no',
    ...(process.env.STPLAY_MPV_DEBUG === '1' ? [] : ['--no-terminal']),
  ]
  if (process.env.STPLAY_MPV_DEBUG === '1') {
    // TRACE TEMPORARIO do demuxer (investigacao do "volta segundos" no live).
    // Sem `--no-terminal`: ele silencia o stderr, e o pipe do scope `mpv`
    // fica mudo mesmo com `msg-level` alto.
    args.push('--msg-level=demux=debug')
  }
  if (liveMode) {
    args.push(`--demuxer-lavf-o=${liveDemuxerLavfO(true)}`)
  } else if (isHls) {
    args.push(`--demuxer-lavf-o=${liveStartIndex()}`)
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
  // O pai vai NA LINHA DE COMANDO. O mpv cria a propria janela e se ancora
  // nele; o app nao precisa reparentar nada depois.
  const args = buildMpvArgs(sourceUrl || 'http://127.0.0.1/', parentHwnd)

  try {
    mpvProc = spawn(mpvPath, args, {
      cwd: path.dirname(mpvPath),
      windowsHide: true,
      // stderr do mpv no log. Antes era 'ignore' e o app ficava cego: quando o
      // `--wid` parou de dar janela, o unico sintoma era `adopted: false`, que
      // nao diz se o mpv recusou a flag, se o HWND do pai estava errado, ou se
      // a janela so nao apareceu no prazo. O mpv escreve o motivo no stderr.
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    return failSpawn(`spawn threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (mpvProc.stderr) {
    mpvProc.stderr.setEncoding('utf8')
    mpvProc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim()
        if (text) log.info('mpv', text)
      }
    })
  }
  log.info('stur', 'mpv argv', {
    pid: mpvProc.pid || 0,
    parentHwnd,
    wid: args.find((a) => a.startsWith('--wid=')) || null,
    forceWindow: args.find((a) => a.startsWith('--force-window=')) || null,
  })

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
  // HEARTBEAT DE DIAGNOSTICO, so com `STPLAY_STATS` setada.
  //
  // Sem isto, "o video travou" e "o video parou" sao indistinguiveis pelo log: o
  // app so escreve quando algo dá errado, e um congelamento silencioso nao
  // escreve nada. Medido: 4 minutos de log mudo com o mpv em 1,4% de CPU, e sem
  // saber se o `time-pos` andava ou nao.
  //
  // A cada 15s sai uma linha com o par que decide a questao: `time-pos` andando
  // = a imagem que nao mexeu e problema de apresentacao; parado = o demuxer parou
  // e e problema de dados.
  const statsOn = Boolean(process.env.STPLAY_STATS)
  let ticks = 0
  raiseTimer = setInterval(() => {
    // `hide()` não derruba mais o timer (era o que deixava a superfície morta
    // sem volta). Então ele precisa se aposentar sozinho quando não há mais nada
    // tocando, senão vira um interval de 1500ms vivo até o fim do processo.
    if (!surfaceActive && !running) {
      clearInterval(raiseTimer)
      raiseTimer = null
      return
    }
    if (!running || !surfaceActive || !mpvHwnd) return
    if ((waitingFirstFrame && !liveMode) || !lastBounds) {
      if (!liveMode) hideVideo()
      return
    }
    if (isSurfaceLost()) {
      log.warn('stur', 'superficie de video perdida — reancorando', {
        detached: isMpvDetached(),
        videoHidden,
        placedKey: lastPlacedKey,
      })
      lastPlacedKey = ''
      showVideo(lastBounds)
      return
    }
    if (videoHidden) showVideo(lastBounds)
    if (liveMode && livePlaybackReady && lastBounds) elevateOverlay()

    if (statsOn && ++ticks % 10 === 0) {
      log.info('stats', 'heartbeat', {
        timePos: lastLiveTimePos,
        cacheTime: lastCacheTime,
        timePosParadoMs: lastLiveTimePosAt > 0 ? Date.now() - lastLiveTimePosAt : -1,
        cacheParadoMs: lastCacheTimeAt > 0 ? Date.now() - lastCacheTimeAt : -1,
        modo: currentLoadMode,
        janelaVisivel: mpvHwnd ? Boolean(winApi && winApi.IsWindowVisible(mpvHwnd)) : null,
        parked: lastPlacedKey.startsWith('-32000,'),
        surfaceLost: isSurfaceLost(),
      })
    }
    // Recuperação de live travado. Duas portas independentes, porque são
    // falhas diferentes e a remediation é a mesma (processo novo, socket novo):
    //
    //   'demuxer silencioso' -> demuxer-cache-time parou de crescer. O socket
    //     está em Established sem entregar byte. É o congelamento medido.
    //   'sem time-pos'       -> time-pos parou. Demuxer vivo, mas nada saindo
    //     para o decoder.
    //
    // A ordem importa: silêncio primeiro, porque é o que o log provou.
    if (liveMode && livePlaybackReady && !userPausedLive && !pausedForCache && !liveStallRecoverBusy) {
      // O canal esta comprovadamente vivo: tem buffer e nao esta travado.
      // Zera o historico de frustracao, para que um encaixe ruim antigo nao
      // possa, sozinho, declarar "canal indisponivel" num canal que hoje
      // esta tocando.
      if (liveUnhealthyLoads > 0 && lastCacheTime >= LIVE_HEALTHY_CACHE_SECS) {
        liveUnhealthyLoads = 0
      }

      if (isLiveUpstreamDead()) {
        // Socket morto: nem a superficie nem o pause resolvem. A unica coisa que
        // resolve e uma conexao nova, e `softReloadLive` mata o processo para
        // garantir isso (o socket keep-alive preso e o que nao quebra sozinho).
        //
        // Este e o ramo que antes NAO EXISTIA: os dois guards antigos
        // devolviam aqui sempre que `lastCacheTime >= 10`, o que neste painel
        // era sempre.
        log.warn('stur', 'socket do demuxer morto: pedindo conexao nova', {
          cacheTime: lastCacheTime,
          cacheParadoMs: Date.now() - lastCacheTimeAt,
          timePos: lastLiveTimePos,
          timePosParadoMs: lastLiveTimePosAt > 0 ? Date.now() - lastLiveTimePosAt : -1,
        })
        liveStallRecoverCount = 0
        // `void`, e nao `await`: o callback do setInterval nao e async, e
        // `softReloadLive` ja se protege sozinho com `softReloadBusy`, entao os
        // tiques seguintes de 1500ms nao empilham recargas.
        void softReloadLive()
        return
      }

      if (isLiveDemuxerSilent()) {        // Buffer cheio e parado = borda viva, NAO e falha. O log original
        // mostrou `timePos: 58.82` contra `cacheTime: 58.81`: o playhead no fim
        // do buffer, esperando o proximo segmento. Reiniciar o processo ai
        // matava um canal saudavel e produzia o ciclo que o usuario viu:
        // trava -> carrega -> volta -> trava.
        //
        // So entra em recuperacao com o buffer VAZIO: ai o demuxer consumiu
        // tudo e esta esperando uma rede que nao entrega.
        if (lastCacheTime >= LIVE_SILENCE_FULL_CACHE_SECS) return
        log.warn('stur', 'live sem dados com o buffer vazio', {
          cacheTime: lastCacheTime,
          ms: Date.now() - lastCacheTimeAt,
          timePos: lastLiveTimePos,
          timePosMs: lastLiveTimePosAt > 0 ? Date.now() - lastLiveTimePosAt : -1,
        })
        void recoverLiveStall('buffer vazio e sem dados')
      } else if (lastLiveTimePosAt > 0 && Date.now() - lastLiveTimePosAt > LIVE_STALL_MS) {
        // Mesmo cuidado: `time-pos` parado COM buffer cheio é a borda viva.
        // Só interessa quando o buffer acabou, que é rede.
        if (lastCacheTime >= LIVE_SILENCE_FULL_CACHE_SECS) return
        log.warn('stur', 'live sem avanco de time-pos', {
          ms: Date.now() - lastLiveTimePosAt,
          cacheTime: lastCacheTime,
        })
        void recoverLiveStall('sem time-pos')
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

  // Ordem vinda de `loadModeOrder(live)`. No live o PRIMEIRO é `http` — o proxy
  // local, o mesmo caminho que o player interno usa e que não trava. Ver a
  // justificativa longa em live-load-policy.cjs: o proxy joga fora o
  // content-length do painel, responde chunked e segue o 302 na stack do
  // Chromium, e o mpv indo direto não tem nenhum dos três.
  //
  // Antes o live tentava SÓ `direct`: `shouldTryHttpFallback(true)` era false, e
  // o proxy ficava fora da jogada por completo, não como fallback.
  // Igual MPEG/Smarters: URL CRUA direta primeiro, sem preflight, sem
  // normalizer, sem redirect. Se o mpv abrir, acabou — o resto da cadeia
  // (proxy/normalizer/remux) só entra se o direto falhar.
  let playUrl = null
  let usedMode = null
  const rawFirst = await loadStream(url, startSec, 'raw')
  if (gen !== loadGeneration) {
    nextLoadSoft = false
    return null
  }
  if (rawFirst) {
    playUrl = rawFirst
    usedMode = 'raw'
  } else {
    for (const mode of loadModeOrder(liveMode)) {
      const url2 = await loadStream(url, startSec, mode)
      if (gen !== loadGeneration) {
        nextLoadSoft = false
        return null
      }
      if (url2) {
        playUrl = url2
        usedMode = mode
        break
      }
    }
  }
  if (playUrl) {
    currentLoadMode = usedMode
    log.info('stur', 'load mode', { mode: usedMode, live: liveMode })
  }
  if (!playUrl || gen !== loadGeneration) {
    nextLoadSoft = false
    return null
  }

  nextLoadSoft = false
  armLoadWatchdog(gen)
  startBufferPoll()
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
  /*
   * Cada `start` e um titulo novo, entao o historico de URLs que falharam nao
   * vale contra este. Sem esta limpeza o teto de `VOD_MAX_URL_TRIES` continuaria
   * valendo de um filme para o outro, e o segundo titulo nem comecaria a tentar.
   */
  vodTriedUrls = new Set()
  if (!liveMode) vodTriedUrls.add(url)
  livePlaybackReady = false
  playbackStable = false
  overlayPresented = false
  userPausedLive = false
  userPausedVod = false
  lastLiveTimePos = -1
  lastLiveTimePosAtPos = -1
  lastLiveTimePosAt = 0
  lastCacheTime = -1
  lastCacheTimeAt = Date.now()
  liveStallRecoverCount = 0
  // Zera o contador de canal morto: `start` é o início de uma tentativa nova,
  // e o histórico de frustração do canal anterior não vale contra este.
  liveUnhealthyLoads = 0
  vodTimeRetries = 0
  clearVodRetry()

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
  // Zap limpa o frame velho na hora + véu de boot, sempre (igual Smarters e
  // igual MPEG). Quadro congelado enquanto o novo não chega era o "trava e
  // abre só depois". Vale live, filme e série.
  try {
    hideVideo()
  } catch {
    // ignore
  }
  if (!softLiveZap) presentLoadingShell()
  else {
    try {
      overlay.sendUi({ action: 'boot' })
    } catch {
      // ignore
    }
  }

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
  // `lastBounds` e `lastPlacedKey` NÃO são limpos aqui, e o `raiseTimer` NÃO é
  // derrubado. Isso era o que deixava a superfície morta sem volta:
  //
  // Snapshot real do app travado: a janela do mpv parentada no overlay, o
  // overlay `iconic` em (-32000,-32000), e as duas janelas do app em
  // (-31403,-31992). A `hideVideo()` tinha jogado o HWND pra -32000 e, com
  // `lastBounds = null` + `raiseTimer = null`, nada mais tinha o duty de
  // trazer de volta. O video ficava fora da tela e o `isMpvDetached()` (que só
  // pergunta `GetParent()`) dizia que estava tudo bem.
  //
  // Agora quem esconde guarda o último rect, e o raise timer continua rodando
  // para poder reancorar. Ele só age quando `surfaceActive` for true de novo.
  overlayPresented = false
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
  // REGISTRO DO RECT QUE A JANELA PRINCIPAL MANDA.
  //
  // Sem esta linha nao ha como responder por que a superficie do mpv cobre o
  // catalogo. Medido no sintoma: a HWND 'mpv' estava em (168,101) 1584x861 —
  // a area do cliente INTEIRA, com o browse embaixo — e `placedKey` chegava
  // vazio no aviso de superficie perdida. `lastBounds` e o que decide o
  // tamanho, e ele vinha de algum lugar que o log nao mostrava.
  //
  // POR TRAS DO PORTAO: `setBounds` e chamado em toda troca de canal, em todo
  // resize, em toda entrada e saida de tela cheia — pelo ResizeObserver. Logar
  // incondicionalmente enche o arquivo de ruido e mascara o que importa. O
  // mesmo desenho de portao que `STPLAY_STATS` e `STPLAY_FS_DEBUG` ja usam.
  if (process.env.STPLAY_BOUNDS_DEBUG) {
    log.info('stur', 'setBounds', {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      cliente: mainWindow ? (() => {
        const c = mainWindow.getContentBounds()
        return `${Math.round(c.width)}x${Math.round(c.height)}`
      })() : null,
    })
  }
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
