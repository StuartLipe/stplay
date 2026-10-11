/**
 * MPEG — mpv embutido com URL crua: sem preflight, sem normalizer, sem remux.
 *
 * O fluxo e o mais simples possivel, e e o que funciona com painel.
 * duas coisas:
 *   1. `loadfile` na URL CRUA, direta, autoplay ligado,
 *      sem preflight de manifesto, sem normalizer, sem resolve de redirect,
 *      sem remux, sem proxy.
 *   2. erro ou fim de stream -> "Playback error, reconnects in 5s (x/5)" e tenta
 *      DE NOVO o MESMO link, até 5 vezes. Só depois mostra erro final.
 *
 * Este motor faz o mesmo com o mpv embutido (mesmo binário do STUR):
 * URL direta no loadfile + retry 5x com 5s. Sem nenhuma inteligência no meio.
 * STUR, interno e os outros continuam existindo, intocados.
 */
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const koffi = require('koffi')
const { screen } = require('electron')
const { findSturMpv } = require('../find-player.cjs')
const hwndHelper = require('./hwnd-helper.cjs')
const log = require('./player-log.cjs')
const overlay = require('./overlay-window.cjs')
const { isPlayableUrl } = require('./play-url.cjs')

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
        /*
         * Registro IDEMPOTENTE das structs.
         *
         * `stur-player.cjs` declara os MESMOS nomes, e os dois motores sao
         * carregados pelo mesmo `player-host.cjs`, no mesmo processo. O koffi
         * guarda o registro por nome no processo: a segunda declaracao levanta
         * "Duplicate type name". Verificado:
         *
         *   koffi.struct('stplay_RECT', {...})  -> 1a ok
         *   koffi.struct('stplay_RECT', {...})  -> Duplicate type name
         *
         * O esquema dos dois e identico (4x int32), entao reutilizar o registro
         * que o stur deixou e correto. Se um dia os esquemas divergirem, o
         * koffi nao avisa - ele simplesmente usa o primeiro. O dia que isso
         * acontecer, o sintoma vai ser retangulo com numero absurdo em
         * `janelaReal`, e a cura e extrair a declaracao para um modulo so.
         */
        for (const [nome, campos] of [
          ['stplay_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }],
          ['stplay_POINT', { x: 'int32', y: 'int32' }],
        ]) {
          try {
            koffi.struct(nome, campos)
          } catch {
            // ja registrada pelo stur neste processo: reaproveita.
          }
        }
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
          GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr, _Out_ stplay_RECT*)'),
          ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr, _Inout_ stplay_POINT*)'),
        }
      })()
    : null

/** 5 tentativas com 5s entre elas, no MESMO link. */
const MPEG_MAX_RETRIES = 5
const MPEG_RETRY_MS = 5000

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
/** Tentativa atual (0 = primeira). O overlay conta 1/5..5/5. */
let retryCount = 0
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let raiseTimer = null
let sourceUrl = null
let mpegLive = false
let lastStartSec = 0
let pendingTitle = ''
let loadGeneration = 0

/** @type {Map<number, (msg: { data?: unknown }) => void>} */
const pendingRequests = new Map()

function isAvailable() {
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
  log.warn('mpeg', 'failed', { reason })
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  emit({ type: 'failed', reason })
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

async function adoptMpv(pid, parent) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const hwnd = findMpvHwnd(pid, parent)
    if (hwnd > 0) {
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
      mpvHwnd = hwnd
      log.info('mpeg', 'adopted', { hwnd, pid, parent, attempt })
      return true
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function ensureEmbedded(show) {
  if (!mpvHwnd || !winApi) return false
  if (mainWindow && !mainWindow.isDestroyed()) {
    const hwnd = windowHwnd(mainWindow)
    if (hwnd) parentHwnd = hwnd
  }
  if (!parentHwnd) return false
  applyMpvWindowStyle(mpvHwnd, show)
  if (Number(winApi.GetParent(mpvHwnd)) !== parentHwnd) {
    winApi.SetParent(mpvHwnd, parentHwnd)
  }
  winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)
  return true
}

function hideVideo() {
  if (!mpvHwnd || !winApi) return
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

/**
 * Retangulo REAL da HWND, em coordenadas de tela.
 *
 * E a unica leitura que nao passa pelo que o app ACHOU que pediu: `lastBounds`
 * e o que veio do renderer, e ele pode estar certo enquanto a janela esta em
 * outro lugar. Portado do `stur-player.cjs`, que ja tinha este defeito medido e
 * documentado; ver o comentario longo em `showVideo` abaixo.
 */
function janelaReal(hwnd) {
  if (!winApi || !hwnd) return null
  try {
    const r = {}
    if (!winApi.GetWindowRect(hwnd, r)) return null
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
  } catch {
    return null
  }
}

/** Origem do cliente do pai, em coordenadas de tela. */
function clienteNaTela(hwnd) {
  if (!winApi || !hwnd) return null
  try {
    const p = { x: 0, y: 0 }
    if (!winApi.ClientToScreen(hwnd, p)) return null
    return { x: p.x, y: p.y }
  } catch {
    return null
  }
}

/** O mpv perdeu o pai? Acontece quando a janela troca de estado de tela. */
function isMpvDetached() {
  if (!mpvHwnd || !winApi || !parentHwnd) return false
  return Number(winApi.GetParent(mpvHwnd)) !== parentHwnd
}

function showVideo(bounds) {
  if (!surfaceActive || !mpvHwnd || !winApi || !bounds || bounds.width < 16) return
  /*
    Os DOIS flags tem de ser lidos ANTES do `ensureEmbedded`.

    `ensureEmbedded` reancora o pai quando necessario, e depois disso
    `isMpvDetached()` passa a falso. Se o flag fosse lido depois, o caso
    "estava desancorado e o ensure consertou" seria perdido - que e justamente
    o caso que precisa do re-elevate. O `stur-player.cjs` le os dois aqui, pelo
    mesmo motivo.
  */
  const wasHidden = videoHidden
  const wasDetached = isMpvDetached()
  if (!ensureEmbedded(true)) return
  const s = scaleFactor()
  const x = Math.round(bounds.x * s)
  const y = Math.round(bounds.y * s)
  const w = Math.max(16, Math.round(bounds.width * s))
  const h = Math.max(16, Math.round(bounds.height * s))
  const placeKey = `${x},${y},${w},${h}`
  /*
   * O DEDUP COMPARAVA COM A PERGUNTA, NAO COM A JANELA.
   *
   * `lastPlacedKey` guardava o que o app JA PEDIU. O Windows, durante a
   * transicao de tela cheia, reposiciona as janelas filhas sozinho - e o cache
   * continuava dizendo que a HWND do mpv estava no lugar certo. Todo retangulo
   * correto seguinte era descartado como duplicado, e o video ficava onde o
   * Windows deixou.
   *
   * MEDIDO no sintoma do dono: entrar em tela cheia deixava o video do tamanho
   * do card, no meio da tela, com o catalogo na esquerda. O log de bounds
   * mostrava o retangulo certo o tempo todo. A HWND era que nao tinha saido do
   * lugar - e o dedup nunca a pesquiava.
   *
   * O `stur` teve este mesmo defeito, com a mesma assinatura, e carrega a
   * correcao desde entao (ver o comentario equivalente em `stur-player.cjs`).
   * O mpeg nunca recebeu: e por isso o bug so aparecia aqui.
   *
   * Agora o dedup so vale quando a janela REAL ja esta no lugar. Custa um
   * `GetWindowRect` e um `ClientToScreen` por chamada, e `showVideo` roda no
   * maximo a 30 Hz por 1,2 s depois de um gatilho.
   */
  if (!videoHidden && !wasDetached && lastPlacedKey === placeKey) {
    const real = janelaReal(mpvHwnd)
    const origem = clienteNaTela(parentHwnd)
    const jaNoLugar =
      real &&
      origem &&
      real.x === origem.x + x &&
      real.y === origem.y + y &&
      real.width === w &&
      real.height === h
    if (jaNoLugar) {
      winApi.EnableWindow(mpvHwnd, false)
      try {
        overlay.syncBounds(bounds)
        overlay.bringToFront()
      } catch {
        // ignore
      }
      return
    }
  }
  lastPlacedKey = placeKey
  winApi.EnableWindow(mpvHwnd, false)
  winApi.MoveWindow(mpvHwnd, x, y, w, h, true)
  /*
    RE-ELEVAR SO QUANDO PRECISA - copiado do stur.

    Antes o mpeg fazia `SetWindowPos(HWND_TOP)` + `ShowWindow` EM TODA chamada
    que passava do dedup. Durante a transicao de tela cheia o Windows esta
    movendo a janela filha sozinho, e forçar ela para o topo da ordem z a cada
    tique briga com o SO: cada yank gera novos eventos, que chamam `showVideo`
    de novo, que yanka de novo. O sintoma era a tela piscando no clique de tela
    cheia.

    O `stur` so re-eleva quando a janela estava escondida ou desancorada -
    `wasHidden || wasDetached`. Nos dois casos o `ensureEmbedded` pode ter
    reancorado o pai, e a janela precisa voltar a aparecer. Nos outros casos o
    `MoveWindow` acima ja posicionou, e o `SetWindowPos` com `SWP_NOSIZE` nao
    acrescenta nada: so mexe na ordem z.
  */
  if (wasHidden || wasDetached || videoHidden) {
    winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    winApi.ShowWindow(mpvHwnd, SW_SHOWNA)
    videoHidden = false
  }
  try {
    overlay.syncBounds(bounds)
    overlay.bringToFront()
  } catch {
    // ignore
  }
}

function placeVideo(bounds) {
  if (!bounds || bounds.width < 16) return
  lastBounds = bounds
  if (waitingFirstFrame) return
  showVideo(bounds)
}

function killMpv() {
  running = false
  waitingFirstFrame = false
  fileLoaded = false
  stopBootPoll()
  clearRetry()
  videoHidden = false
  lastBounds = null
  lastPlacedKey = ''
  if (raiseTimer) {
    clearInterval(raiseTimer)
    raiseTimer = null
  }
  try {
    ipcSocket?.destroy()
  } catch {
    // ignore
  }
  ipcSocket = null
  const pid = mpvProc?.pid
  mpvProc = null
  try {
    hideVideo()
  } catch {
    // ignore
  }
  mpvHwnd = 0
  if (pid) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
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
      })
      resolve(true)
    })
    socket.once('error', () => {
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

function onFirstFrame() {
  if (!waitingFirstFrame) return
  waitingFirstFrame = false
  retryCount = 0
  stopBootPoll()
  emit({ type: 'playing' })
  if (lastBounds) {
    showVideo(lastBounds)
    try {
      overlay.show(mainWindow, lastBounds, { engine: 'MPEG', title: pendingTitle })
      // VOD: não manda playback-ready no primeiro quadro — deixa o boot poll
      // subir até 100% e mandar hide-loading. Live manda playback-ready normal.
      if (mpegLive) {
        overlay.sendUi({ action: 'playback-ready' })
      }
    } catch {
      // ignore
    }
  }
  log.info('mpeg', 'first frame')
}

function scheduleRetry(reason) {
  // Erro no load: → tenta o MESMO link de novo em 5s, até 5x.
  if (retryCount >= MPEG_MAX_RETRIES) {
    emitFailed(reason || 'MPEG não abriu')
    killMpv()
    return
  }
  retryCount += 1
  const gen = loadGeneration
  log.warn('mpeg', 'reconnect', { try: `${retryCount}/${MPEG_MAX_RETRIES}`, reason })
  // Reconexão ("reconnects in 5s (x/5)"): o overlay mostra o contador.
  emit({ type: 'buffering', value: true, percent: 0, retry: retryCount, of: MPEG_MAX_RETRIES })
  clearRetry()
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (gen !== loadGeneration) return
    // Teto de 5 no total: sem esta guarda o timer da
    // 5ª tentativa disparava um 6º loadfile antes do end-file decretar o fim.
    if (retryCount >= MPEG_MAX_RETRIES) {
      emitFailed(reason || 'MPEG não abriu')
      killMpv()
      return
    }
    void loadDirect(sourceUrl, lastStartSec, gen)
  }, MPEG_RETRY_MS)
}

function handleIpcMessage(msg) {
  if (msg.event === 'property-change') {
    if (msg.name === 'time-pos' && typeof msg.data === 'number') {
      // Só emite tempo quando há arquivo: o `time-pos` residual de uma sessão
      // anterior faria a barra de progresso andar sobre um vídeo que não existe.
      if (fileLoaded) {
        emit({ type: 'timeupdate', current: msg.data })
        if (waitingFirstFrame) onFirstFrame()
      }
    }
    if (msg.name === 'duration' && typeof msg.data === 'number' && msg.data > 0) {
      emit({ type: 'duration', value: msg.data })
    }
    /*
     * `pause` NAO FALA DA INTERFACE ANTES DO PRIMEIRO QUADRO.
     *
     * O mpv publica `pause = false` assim que o arquivo carrega, muito antes do
     * primeiro quadro decodificar. Emitir `playing` nesse instante diz ao overlay que
     * "o quadro esta na tela" — e o overlay usa `playing` para PODER desligar a
     * animacao de buffering. Com ele chegando cedo, o veu sumia sobre a tela preta:
     * o dono via preto sem animacao e so depois o video aparecia.
     *
     * O mesmo cuidado existe no STUR, em `stur-player.cjs`, no mesmo evento — la o
     * VOD sai do handler antes de emitir. E vale pelo segundo motivo tambem:
     * `cache-pause` mexe na property `pause` durante o buffering, e isso nao e a
     * pessoa pausando.
     *
     * Sem `return`: o resto do handler precisa rodar — e o `dwidth` logo abaixo que
     * destrava o retry quando o arquivo morre antes do primeiro quadro.
     */
    if (msg.name === 'pause' && !waitingFirstFrame) {
      emit({ type: msg.data ? 'paused' : 'playing' })
    }
    if (msg.name === 'dwidth' && typeof msg.data === 'number' && msg.data > 0) {
      /*
       * `fileLoaded` é obrigatório, e não é redundância com o `dwidth`.
       *
       * O mpv MANTÉM properties entre `loadfile` — o `dwidth` da sessão anterior
       * continua valendo logo depois do `loadfile` novo. Medido no 1575711
       * (Dálmatas, ID morto no painel):
       *
       *   00:45:11.569  adopted
       *   00:45:11.594  first frame     <-- 25ms
       *   00:45:11.595  loadfile ok
       *
       * `first frame` ANTES do `loadfile ok`, sem nenhum `file-loaded` no
       * intervalo. Era o `dwidth` residual: o app emitia `playing`, mostrava o
       * overlay, e o usuário ficava olhando tela preta sem nenhuma indicação de
       * erro — o timeout de 20s só viria depois, e mesmo assim o retry só
       * happens se `waitingFirstFrame` ainda for true, o que já não era.
       *
       * Ou seja: o MPEG declarava sucesso sobre um título que não abre. Um log
       * que diz "abriu" quando não abriu é pior que log nenhum — foi o que me
       * mandou medir a diferença entre os dois motores antes de saber que não
       * havia diferença nenhuma.
       */
      if (fileLoaded && waitingFirstFrame) onFirstFrame()
    }
    if (msg.name === 'cache-buffering-state' && typeof msg.data === 'number') {
      /*
       * Percentual 0-100, mas NUNCA abaixo do que o relógio já mostrou.
       *
       * Este era o segundo furo do VOD, e é o que produzia o "a bola pisca e some,
       * e a tela fica preta" do dono. O mpv empurra `cache-buffering-state = 100`
       * quando o cache enche — e isso acontece ANTES do primeiro quadro ser
       * decodificado. O `pct < 100` mandava `value: false`, o overlay recebia,
       * e a linha `event.value === false` escondia o booting. Como o quadro ainda
       * não tinha chegado, ninguém reabria o véu: buraco preto até o `playing`.
       *
       * A correção é não deixar o dado do mpv REBAIXAR o progresso, e não deixar
       * ele esconder o véu antes do primeiro play. Quem fecha o booting, antes do
       * primeiro quadro, é o evento `playing` — e só ele.
       */
      const pct = Math.max(0, Math.min(100, Math.round(msg.data)))
      if (waitingFirstFrame) {
        emit({ type: 'buffering', value: true, percent: Math.max(pct, bootPctFloor) })
      } else {
        emit({ type: 'buffering', value: pct > 0 && pct < 100, percent: pct })
      }
    }
    return
  }
  if (msg.event === 'file-loaded') {
    fileLoaded = true
    return
  }
  if (msg.request_id && pendingRequests.has(msg.request_id)) {
    const cb = pendingRequests.get(msg.request_id)
    pendingRequests.delete(msg.request_id)
    try {
      cb(msg)
    } catch {
      // ignore
    }
    return
  }
  if (msg.event === 'end-file') {
    // EOF de verdade (VOD acabou) não é erro .
    if (msg.reason === 'eof') {
      retryCount = 0
      emit({ type: 'ended' })
      return
    }
    // Troca de canal no meio do retry: o end-file do canal velho não conta.
    if (msg.reason === 'stop' || msg.reason === 'quit') return
    const hint = String(mpvStderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)
    log.warn('mpeg', 'end-file', { reason: msg.reason, stderr: hint || null, try: retryCount + 1 })
    scheduleRetry(`MPEG end-file ${msg.reason || 'error'}`)
  }
}

/*
 * NAO EXISTE MAIS `getProperty` AQUI.
 *
 * Ela enfileirava um `get_property` no socket do mpv e resolvia em 1,2 s, e o
 * poll de boot chamava a cada 400 ms — a fila nunca esvaziava, toda requisição
 * expirava e `demuxer-cache-time` voltava `null` para sempre. Foi isso que deixou
 * a porcentagem travada em 1 no carregamento inteiro, no ao vivo e no filme.
 *
 * O percentual agora vem do relógio (`startBootPoll`), e o único dado real que
 * entra é o `cache-buffering-state`, que o mpv EMPURRA sozinho — sem requisição,
 * sem fila, sem timeout. Se um dia precisar de outra propriedade, use o mesmo
 * caminho: `observe_property`, nunca `get_property` em ciclo curto.
 */

/**
 * Percentual 0-100 enquanto o 1º frame não chega.
 *
 * `bootPctFloor` é o PISO que o `cache-buffering-state` observado pelo mpv não
 * pode furar. Ele sobe com a curva do relógio e nunca regride; ver o comentário
 * de `startBootPoll` e o do handler de `cache-buffering-state` para os dois
 * defeitos que ele segura (barra voltando, e bootstrap sumindo cedo demais).
 */
let bootPollTimer = null
/** Maior percentual já mostrado na carga atual. Zera a cada `startBootPoll`. */
let bootPctFloor = 0

function stopBootPoll() {
  if (bootPollTimer) {
    clearInterval(bootPollTimer)
    bootPollTimer = null
  }
}

/**
 * Progresso por TEMPO, não por `get_property`.
 *
 * MEDIDO no painel do dono (16:54, filme 1575712 pelo mpeg): 32 tiques seguidos,
 * todos com `demuxer-cache-time` = `null`, e `pct` travado em 1 o carregamento
 * inteiro. O spinner aparecia, mostrava "1%" e ficava lá — ou pior, o `playing`
 * chegava e limpava, e sobrava tela preta sem explicação.
 *
 * A causa é a mesma que o `stur` já documentou em `stur-player.cjs`: este poll
 * enfileira a cada 400 ms contra um `get_property` que só responde em ~1,2 s.
 * Toda requisição ainda está pendente quando a próxima chega, a fila cresce, e o
 * timeout de 1,2 s expira uma a uma — `null` para sempre.
 *
 * Por isso o número vem do RELÓGIO, e só o `cache-buffering-state` observado pelo
 * mpv (que chega empurrado, sem polling) pode corrigir a curva para cima. É a
 * mesma curva do `stur`: 0→80% nos primeiros 8 s, 80→95% até 20 s, e 95% depois.
 * Chega a 100% só com dado real (`onFirstFrame`), nunca no relógio — inventar
 * 100% no tempo seria o mesmo defeito que o `1%` constante, invertido.
 */
function startBootPoll() {
  stopBootPoll()
  const startedAt = Date.now()
  /*
   * O percentual é ACUMULATIVO, e o motivo é o mesmo do `stur`
   * (`reportBufferPercent`: `Math.max(cachePercent, effectivePct)`).
   *
   * Sem o `highest`, dois caminhos fazem a barra andar para trás no VOD:
   *
   *   1. O `cache-buffering-state` observado pelo mpv chega com um valor menor
   *      que a curva do relógio (o cache pode transbordar e `demuxer-cache-time`
   *      cair). O overlay guarda `prev` e ignora a regressão — mas o próximo
   *      tique do relógio manda a curva inteira de novo, e aí a barra desce.
   *   2. Dois `start()` na mesma sessão (zape rápido) compartilham `shown`, e o
   *      segundo começa com o valor do primeiro — o número "anda para trás" entre
   *      um canal e outro.
   *
   * O `highest` é zerado em `startBootPoll`, então cada carga recomeça do seu
   * próprio zero. O que nunca regride é o progresso DENTRO de uma carga, que é o
   * que o olho lê como "carregando".
   */
  let highest = 0
  bootPctFloor = 0
  bootPollTimer = setInterval(() => {
    if (!running || !waitingFirstFrame) {
      stopBootPoll()
      return
    }
    const elapsedMs = Date.now() - startedAt
    let pct
    if (elapsedMs < 8000) pct = Math.round((elapsedMs / 8000) * 80)
    else if (elapsedMs < 20000) pct = 80 + Math.round(((elapsedMs - 8000) / 12000) * 15)
    else pct = 95
    highest = Math.max(highest, pct, 1)
    /*
     * O piso e o `cache-buffering-state` (dado real) ou a curva do relogio, o que
     * for MAIOR. `cache-buffering-state = 100` antes do primeiro quadro nao pode
     * derrubar a barra nem esconder o veu — ver o handler da propriedade.
     */
    bootPctFloor = Math.max(bootPctFloor, highest)
    emit({ type: 'buffering', value: true, percent: Math.min(95, bootPctFloor) })
  }, 400)
}

function sendIpc(command) {
  return new Promise((resolve) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      resolve({ ok: false })
      return
    }
    const id = ++requestId
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      resolve({ ok: false })
    }, 3000)
    pendingRequests.set(id, () => {
      clearTimeout(timer)
      resolve({ ok: true })
    })
    try {
      ipcSocket.write(JSON.stringify({ command, request_id: id }) + '\n')
    } catch {
      clearTimeout(timer)
      pendingRequests.delete(id)
      resolve({ ok: false })
    }
  })
}

async function observeProperties() {
  const props = ['time-pos', 'duration', 'pause', 'dwidth', 'cache-buffering-state']
  for (let i = 0; i < props.length; i++) {
    try {
      if (ipcSocket && !ipcSocket.destroyed) {
        ipcSocket.write(JSON.stringify({ command: ['observe_property', i + 1, props[i]] }) + '\n')
      }
    } catch {
      // ignore
    }
  }
}

function setMainWindow(win) {
  mainWindow = win
}

/** URL CRUA no mpv — sem preflight, sem normalizer, sem redirect. */
async function loadDirect(url, startSec, gen) {
  if (gen !== loadGeneration) return null
  waitingFirstFrame = true
  fileLoaded = false
  startBootPoll()
  const safe = String(url).replace(/\\/g, '/')
  if (startSec > 0) await sendIpc(['set_property', 'start', String(Math.floor(startSec))])
  else await sendIpc(['set_property', 'start', 'none'])
  const res = await sendIpc(['loadfile', safe, 'replace'])
  if (gen !== loadGeneration) return null
  if (!res.ok) {
    scheduleRetry('MPEG loadfile recusado')
    return null
  }
  log.info('mpeg', 'loadfile ok', { try: retryCount + 1, url: String(url).slice(0, 100) })
  // Depois do loadfile, nao antes: `panscan` e `keepaspect` sao ajustados pelo
  // VO assim que existe um display, e antes disso o mpv aceita o comando mas
  // nao tem o que aplicar.
  //
  // Sem `await` pelo mesmo motivo do stur: este `loadDirect` e aguardado pelo
  // `start`, e segurar o start em duas idas-e-voltas de 8s atrasa o "pronto"
  // da UI por tempo que nao e do usuario. O lote vai num write so.
  void aplicarAspecto(currentAspect)
  // Sem file-loaded em 20s: conta como tentativa queimada, retry.
  setTimeout(() => {
    if (gen !== loadGeneration || !running) return
    if (!fileLoaded && waitingFirstFrame) scheduleRetry('MPEG não carregou')
  }, 20000)
  return true
}

async function start(win, url, startTime = 0, bounds = null, opts = {}) {
  if (!isAvailable()) return { ok: false, error: 'mpv não encontrado' }
  if (!win || win.isDestroyed()) return { ok: false, error: 'Janela indisponível' }
  if (typeof url !== 'string' || !isPlayableUrl(url)) return { ok: false, error: 'URL inválida' }

  loadGeneration += 1
  const gen = loadGeneration
  clearRetry()
  killMpv()
  mainWindow = win
  running = true
  surfaceActive = true
  lastBounds = bounds
  waitingFirstFrame = true
  fileLoaded = false
  retryCount = 0
  sourceUrl = url
  mpegLive = opts.live === true
  lastStartSec = typeof startTime === 'number' && startTime > 1 ? Math.floor(startTime) : 0
  pendingTitle = typeof opts.title === 'string' ? opts.title : ''

  parentHwnd = windowHwnd(win)
  if (!parentHwnd) {
    running = false
    return { ok: false, error: 'HWND pai inválido' }
  }
  try {
    hwndHelper.prepareParent(parentHwnd)
  } catch {
    // ignore
  }
  try {
    win.setBackgroundColor('#00000000')
  } catch {
    // ignore
  }

  const mpvPath = findSturMpv()
  pipePath = `\\\\.\\pipe\\stplay-mpeg-${process.pid}-${++pipeCounter}`
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }

  // mpv direto, flags mínimas — autoplay, hwdec,
  // UA de VLC (painel libera igual), sem cache agressivo que atrasa o 1º frame.
  //
  // `keepaspect` vai na argv E na propriedade: na argv para o primeiro frame ja
  // nascer certo (sem um flash de tarja antes do `loadfile`), na propriedade
  // porque `aplicarAspecto` roda depois do loadfile e cobre o reload.
  if (aspectoValido(opts?.aspect)) currentAspect = opts.aspect
  const args = [
    `--input-ipc-server=${pipePath}`,
    '--idle=yes',
    '--keep-open=yes',
    '--force-window=yes',
    '--geometry=320x180+20000+20000',
    `--keepaspect=${currentAspect === 'wide' ? 'no' : 'yes'}`,
    // Busca por keyframe em vez de quadro exato. O padrao do mpv decodifica ate
    // o quadro pedido, e num VOD pela rede isso e reler do keyframe a cada salto
    // e a cada arrasto — o filme congela na mao do usuario.
    // `STPLAY_HR_SEEK=0` volta ao comportamento exato.
    ...(process.env.STPLAY_HR_SEEK === '0' ? [] : ['--hr-seek=yes']),
    '--no-border',
    '--osc=no',
    '--osd-level=0',
    '--osd-bar=no',
    '--osd-on-seek=no',
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    '--vo=gpu-next',
    '--hwdec=auto',
    '--hdr-compute-peak=yes',
    '--tone-mapping=auto',
    '--cache=yes',
    '--demuxer-max-bytes=32MiB',
    '--demuxer-max-back-bytes=16MiB',
    '--user-agent=VLC/3.0.20 LibVLC/3.0.20',
    '--network-timeout=15',
    '--no-terminal',
    `--wid=${parentHwnd}`,
  ]
  if (origin && !/127\.0\.0\.1/i.test(url)) args.push(`--referrer=${origin}/`)

  try {
    mpvProc = spawn(mpvPath, args, {
      cwd: path.dirname(mpvPath),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    running = false
    return { ok: false, error: error instanceof Error ? error.message : 'spawn failed' }
  }

  // stderr do mpv: guarda o rabo pra dizer POR QUE o end-file deu error
  // (403/404/rede) em vez de só "error".
  let mpvStderr = ''
  try {
    mpvProc.stderr?.on('data', (chunk) => {
      mpvStderr = (mpvStderr + chunk.toString()).slice(-1500)
    })
  } catch {
    // ignore
  }

  const pid = mpvProc.pid || 0
  mpvProc.on('exit', () => {
    if (gen !== loadGeneration) return
    if (running && waitingFirstFrame) scheduleRetry('MPEG encerrou')
    else killMpv()
  })

  const [ipcOk, adopted] = await Promise.all([connectIpc(), adoptMpv(pid, parentHwnd)])
  if (gen !== loadGeneration) return { ok: false, cancelled: true }
  if (!ipcOk || !adopted) {
    killMpv()
    log.warn('mpeg', 'start failed', { ipcOk, adopted, pid })
    return {
      ok: false,
      error: !ipcOk ? 'Falha ao conectar MPEG (IPC)' : 'Falha ao adotar janela MPEG',
    }
  }

  await observeProperties()
  emit({ type: 'ready' })

  raiseTimer = setInterval(() => {
    if (!running || waitingFirstFrame || !mpvHwnd || !lastBounds) return
    showVideo(lastBounds)
  }, 600)

  if (bounds && bounds.width >= 32) {
    try {
      overlay.show(win, bounds, { engine: 'MPEG', title: pendingTitle })
    } catch {
      // ignore
    }
  }

  await loadDirect(url, lastStartSec, gen)
  if (gen !== loadGeneration) return { ok: false, cancelled: true }
  log.info('mpeg', 'started', { pid, hwnd: mpvHwnd, url: String(url).slice(0, 80) })
  return { ok: true, engine: 'mpeg' }
}

async function reload(win, url, startTime, bounds, opts = {}) {
  // No reload com o processo vivo nao ha spawn, entao a argv nao roda: o modo
  // so entraria pelo `aplicarAspecto` que o `loadDirect` chama. Atualizar aqui
  // e o que faz `wide` valer no zape seguinte, e nao so no proximo app aberto.
  if (aspectoValido(opts?.aspect)) currentAspect = opts.aspect
  if (!running || !mpvProc || mpvProc.exitCode !== null) {
    return start(win, url, startTime, bounds, opts)
  }
  loadGeneration += 1
  const gen = loadGeneration
  clearRetry()
  mainWindow = win
  running = true
  surfaceActive = true
  lastBounds = bounds || lastBounds
  retryCount = 0
  sourceUrl = url
  mpegLive = opts.live === true
  lastStartSec = typeof startTime === 'number' && startTime > 1 ? Math.floor(startTime) : 0
  pendingTitle = typeof opts.title === 'string' ? opts.title : pendingTitle
  // Zap: limpa o frame velho na hora + véu de boot (nada
  // de quadro congelado enquanto o novo não chega). Vale live e VOD.
  try {
    hideVideo()
  } catch {
    // ignore
  }
  try {
    overlay.sendUi({ action: 'boot' })
  } catch {
    // ignore
  }
  emit({ type: 'buffering', value: true, percent: 0 })
  await loadDirect(url, lastStartSec, gen)
  return { ok: true, engine: 'mpeg' }
}

function stop(opts = {}) {
  loadGeneration += 1
  clearRetry()
  surfaceActive = false
  killMpv()
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  return { ok: true }
}

function hide() {
  surfaceActive = false
  try {
    hideVideo()
  } catch {
    // ignore
  }
  return { ok: true }
}

/**
 * Ajuste da imagem. Ver `aplicarAspecto`.
 *
 * Vive em modulo, e nao em variavel da sessao, porque o `reload` reaproveita o
 * mesmo processo do mpv: trocar de canal tem que manter o modo que o usuario
 * escolheu, nao voltar ao padrao.
 */
let currentAspect = 'fill'

/**
 * `fit` deixa a tarja, `fill` corta a borda da imagem ate preencher, `wide`
 * estica e perde a proporcao.
 *
 * Sao duas propriedades e nao uma flag de spawn porque o `keepaspect` deste
 * mpv responde a `set_property` em tempo de execucao — medido: `set_property
 * keepaspect no` devolveu `error: success` com o processo de idle rodando.
 * Antes de assumir isso eu tinha deixado `wide` valendo so no proximo canal;
 * com o probe ele passa a valer na hora, sem matar nem recarregar a surface.
 *
 * `panscan` e o quanto da fonte pode ser cortado para casar com a janela. Em 0
 * sobra tarja, em 1 o mpv corta exatamente o necessario.
 */
const ASPECTO_PANSCAN = { fit: '0', fill: '1', wide: '0' }

function aspectoValido(modo) {
  return modo === 'fit' || modo === 'fill' || modo === 'wide'
}

async function aplicarAspecto(modo) {
  if (!aspectoValido(modo)) return { ok: false }
  currentAspect = modo
  try {
    // Dois `sendIpc`, e nao um lote: `sendIpcBatch` so existe no `stur`. Aqui
    // cada um custa uma ida-e-volta com timeout de 8s, e isso NAO segura nada
    // — quem chama e `void`, logo depois do `loadfile`. Empilhar num write so
    // seria otimizacao sem ganho, e referencia a uma funcao que nao existe aqui
    // seria engolida pelo `catch` e deixaria o MPEG sem ajuste, em silencio.
    await sendIpc(['set_property', 'keepaspect', modo === 'wide' ? 'no' : 'yes'])
    await sendIpc(['set_property', 'panscan', ASPECTO_PANSCAN[modo]])
    log.info('mpeg', 'aspecto', {
      modo,
      keepaspect: modo === 'wide' ? 'no' : 'yes',
      panscan: ASPECTO_PANSCAN[modo],
    })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * SEEK COALESCIDO — mesma regra do `stur-player.cjs`, e o mesmo motivo.
 *
 * Cada seek manda o mpv recarregar a regiao desejada. Arraste da barra e cliques
 * repetidos viravam N recargas em menos de um segundo, e o video congela
 * esperando o buffer. Relativo acumula (tres "-10s" = um "-30s"), absoluto
 * substitui (arrastar escolhe um lugar), e nunca ha dois em voo.
 */
async function command(op, value, mode) {
  if (!ipcSocket || ipcSocket.destroyed) return { ok: false }
  try {
    if (op === 'pause') await sendIpc(['set_property', 'pause', true])
    else if (op === 'play') await sendIpc(['set_property', 'pause', false])
    else if (op === 'toggle' || op === 'toggle-pause') await sendIpc(['cycle', 'pause'])
    else if (op === 'seek' && typeof value === 'number') {
      // Mesma razao do stur: `relative` aplica a partir da posicao real do mpv.
      // Seek absoluto com destino atrasado do renderer vira seek para tras, e
      // seek para tras descarta o buffer.
      await sendIpc(['seek', value, mode === 'relative' ? 'relative' : 'absolute'])
    }
    else if (op === 'volume' && typeof value === 'number') {
      await sendIpc(['set_property', 'volume', Math.round(Math.max(0, Math.min(100, value * 100)))])
    } else if (op === 'mute' && typeof value === 'boolean') {
      await sendIpc(['set_property', 'mute', value])
    } else if (op === 'aspect') {
      return await aplicarAspecto(value)
    } else return { ok: false }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function setBounds(rect) {
  if (!rect) return { ok: false }
  /*
    LOG DE BOUNDS - copiado do `stur-player.cjs`, que tem o mesmo portao.

    Sem isto nao da para comparar os dois motores: o stur grava o retangulo que
    recebe e o mpeg nao, e a investigacao do "fica grande em modo janela" precisa
    justamente dos DOIS numeros lado a lado. Medido pelo dono: o stur volta ao
    tamanho certo e o mpeg fica com o retangulo de tela cheia.

    Atras de `STPLAY_BOUNDS_DEBUG` porque `setBounds` e chamado em toda troca de
    canal, em todo resize e em cada frame da reconciliacao - logar sempre encheria
    o arquivo e esconderia o que importa.
  */
  if (process.env.STPLAY_BOUNDS_DEBUG) {
    log.info('mpeg', 'setBounds', {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      cliente: mainWindow
        ? (() => {
            const c = mainWindow.getContentBounds()
            return `${Math.round(c.width)}x${Math.round(c.height)}`
          })()
        : null,
      fullscreen: mainWindow && !mainWindow.isDestroyed() ? mainWindow.isFullScreen() : null,
      surfaceActive,
      hwnd: mpvHwnd || null,
    })
  }
  placeVideo(rect)
  return { ok: true }
}

function refreshLayout() {
  if (lastBounds) placeVideo(lastBounds)
}

function isRunning() {
  return running && Boolean(mpvProc) && mpvProc.exitCode === null
}

function abortActiveLoad() {
  loadGeneration += 1
  clearRetry()
}

module.exports = {
  isAvailable,
  setMainWindow,
  start,
  reload,
  stop,
  hide,
  command,
  setBounds,
  refreshLayout,
  isRunning,
  isBusy: () => false,
  abortActiveLoad,
}
