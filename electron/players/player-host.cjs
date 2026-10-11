const { ipcMain, BrowserWindow, globalShortcut } = require('electron')
const { findMpv } = require('../find-player.cjs')
const libmpv = require('./libmpv-player.cjs')
const mpvExe = require('./mpv-exe-player.cjs')
const mpvOne = require('./mpv-one-player.cjs')
const stur = require('./stur-player.cjs')
const mpeg = require('./mpeg-player.cjs')
const sturProxy = require('../stur-ffmpeg-proxy.cjs')
const external = require('./external-player.cjs')
const overlay = require('./overlay-window.cjs')
const { videoContentRect } = require('./overlay-bounds.cjs')
const log = require('./player-log.cjs')
const { normalizePlayUrl, isPlayableUrl } = require('./play-url.cjs')

/** @type {'libmpv' | 'mpv' | 'mpv-one' | 'stur' | 'vlc' | 'mpc' | null} */
let activeEngine = null
/** @type {import('electron').BrowserWindow | null} */
let boundWindow = null
let playbackActive = false
let playbackShortcutsOn = false

const PLAYBACK_SHORTCUT_KEYS = ['Escape', 'Up', 'Down', 'Left', 'Right']
/*
  F11 NAO esta mais em atalho global.

  Medido com video tocando: o F11 nao entrava nem saia de tela cheia. A causa
  era duplo-toggle no mesmo toque — `globalShortcut` invertia a tela cheia e o
  `before-input-event` de `bindFullscreenHooks` invertia de volta, no mesmo
  evento. Saldo zero, janela parada.

  O unico dono do F11 agora e o `before-input-event`, que roda uma vez so e
  cobre home e player. O `globalShortcut` continua so com Escape e setas.
*/
const FOCUS_ONLY_SHORTCUT_KEYS = []

function sendPlaybackKey(key) {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    if (!playbackActive) return
    win.webContents.send('player:ui-key', { key })
  } catch {
    // ignore
  }
}

function unregisterShortcutKey(key) {
  try {
    globalShortcut.unregister(key)
  } catch {
    // ignore
  }
}

function unregisterAllPlaybackShortcuts() {
  for (const key of PLAYBACK_SHORTCUT_KEYS) {
    unregisterShortcutKey(key)
  }
  for (const key of FOCUS_ONLY_SHORTCUT_KEYS) {
    unregisterShortcutKey(key)
  }
  playbackShortcutsOn = false
}

function registerPlaybackShortcuts() {
  if (playbackShortcutsOn) return
  let registered = 0
  for (const key of PLAYBACK_SHORTCUT_KEYS) {
    try {
      if (globalShortcut.register(key, () => sendPlaybackKey(key))) registered += 1
    } catch {
      // ignore
    }
  }
  playbackShortcutsOn = registered > 0
}

function registerFocusOnlyShortcuts() {
  for (const key of FOCUS_ONLY_SHORTCUT_KEYS) {
    try {
      globalShortcut.register(key, () => sendPlaybackKey(key))
    } catch {
      // ignore
    }
  }
}

function unregisterPlaybackShortcuts() {
  unregisterAllPlaybackShortcuts()
}

function bindWindowFocusShortcuts(win) {
  if (!win || win.isDestroyed() || win.__sturPlaybackFocusBound) return
  win.__sturPlaybackFocusBound = true
  win.on('focus', () => {
    // F11 entra com a janela em foco, com ou sem player. O resto dos atalhos
    // (Escape, setas) so faz sentido durante a reproducao.
    registerFocusOnlyShortcuts()
    if (!playbackActive) return
    registerPlaybackShortcuts()
  })
  win.on('blur', () => {
    unregisterAllPlaybackShortcuts()
  })
  /*
    F11 e resolvido no `before-input-event` do `bindNativeFullscreenHooks`, que
    roda uma vez so e cobre home e player. Nao ha F11 aqui para nao inverter a
    tela cheia duas vezes no mesmo toque (aqui e no globalShortcut).
  */
}

function markPlaybackActive(active) {
  playbackActive = active === true
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    if (!playbackActive) unregisterAllPlaybackShortcuts()
    return
  }
  bindWindowFocusShortcuts(win)
  if (playbackActive) {
    if (win.isFocused()) {
      registerPlaybackShortcuts()
      registerFocusOnlyShortcuts()
    }
  } else {
    unregisterAllPlaybackShortcuts()
  }
}

const DEFAULT_WINDOW_BG = '#07090f'
// Transparente: o HWND do mpv aparece sem “borda” opaca.
const NATIVE_WINDOW_BG = '#00000000'

function setNativeVideoCompositor(win, enabled) {
  if (!win || win.isDestroyed()) return
  try {
    win.setBackgroundColor(enabled ? NATIVE_WINDOW_BG : DEFAULT_WINDOW_BG)
  } catch {
    // ignore
  }
}

function getMainWindow() {
  if (boundWindow && !boundWindow.isDestroyed()) return boundWindow
  return (
    BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.isModal() && !w.getParentWindow(),
    ) || null
  )
}

function detect() {
  return {
    ok: true,
    internal: true,
    libmpv: libmpv.isAvailable(),
    mpv: Boolean(findMpv()),
    mpvOne: mpvOne.isAvailable(),
    stur: stur.isAvailable(),
    mpeg: mpeg.isAvailable(),
    vlc: external.hasVlc(),
    mpc: external.hasMpc(),
  }
}

function focusMainWindow(win) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.focus()
  } catch {
    // ignore
  }
}

/** Esconde HWND/overlay na hora — sem matar mpv (não bloqueia o renderer). */
function hideSurfacesFast() {
  bumpHostEpoch()
  markPlaybackActive(false)
  activeEngine = null
  const win = getMainWindow()
  setNativeVideoCompositor(win, false)
  try {
    stur.abortActiveLoad()
  } catch {
    // ignore
  }
  try {
    mpeg.abortActiveLoad()
  } catch {
    // ignore
  }
  try {
    overlay.hide()
  } catch {
    // ignore
  }
  try {
    stur.hide()
  } catch {
    // ignore
  }
  try {
    mpeg.hide()
  } catch {
    // ignore
  }
  try {
    overlay.destroyIfIdle?.()
  } catch {
    // ignore
  }
  focusMainWindow(win)
  return { ok: true }
}

function hideSurfaces() {
  hideSurfacesFast()
  // Mata motores em background — evita travar IPC com taskkill síncrono.
  setImmediate(() => {
    try {
      // `isBusy()` cobre a janela em que `ensureMpv` roda: lá `isRunning()` é
      // false (HWND ainda não adotado) e o stop era pulado, deixando mpv.exe
      // órfão ainda baixando o live depois do usuário ter saído.
      if (stur.isRunning() || stur.isBusy()) stur.stop()
    } catch {
      // ignore
    }
    try {
      if (mpeg.isRunning()) mpeg.stop()
    } catch {
      // ignore
    }
    try {
      mpvOne.stop?.()
    } catch {
      // ignore
    }
    try {
      mpvExe.stop?.()
    } catch {
      // ignore
    }
    try {
      libmpv.stop({ immediate: true })
    } catch {
      // ignore
    }
  })
  return { ok: true }
}

async function stopAll() {
  markPlaybackActive(false)
  activeEngine = null
  setNativeVideoCompositor(getMainWindow(), false)
  try {
    stur.hide()
  } catch {
    // ignore
  }
  try {
    mpeg.hide()
  } catch {
    // ignore
  }
  try {
    libmpv.stop({ immediate: true })
  } catch {
    // ignore
  }
  try {
    mpvExe.stop()
  } catch {
    // ignore
  }
  try {
    mpvOne.stop()
  } catch {
    // ignore
  }
  try {
    // Sem `sync: true`. O sync executa `execSync('taskkill', { timeout: 3000 })`
    // e congela o processo principal inteiro — e `player:stop` chega do unmount do
    // Player, ou seja, no meio da navegacao. Era o "cliquei e a tela travou".
    // `killMpv` ja dispara o taskkill em background; aqui o `await` so espera
    // ele terminar, sem travar o main.
    await stur.stop()
  } catch {
    // ignore
  }
  try {
    await mpeg.stop()
  } catch {
    // ignore
  }
  try {
    external.stop()
  } catch {
    // ignore
  }
  try {
    // Derruba o ffmpeg do proxy tambem: ele e um processo separado, com audio
    // proprio, e sobrevivia a saida do player.
    sturProxy.stop()
  } catch {
    // ignore
  }
  overlay.hide()
  return { ok: true }
}

const hwndHelper = require('./hwnd-helper.cjs')

/** Serializa stop/start para evitar corrida ao trocar episódio. */
let hostOp = Promise.resolve()
let hostEpoch = 0

function bumpHostEpoch() {
  hostEpoch += 1
  return hostEpoch
}

function runHostOp(fn) {
  const epoch = hostEpoch
  const wrapped = async () => {
    if (epoch !== hostEpoch) return { ok: false, cancelled: true }
    const result = await fn()
    if (epoch !== hostEpoch) return { ok: false, cancelled: true }
    return result
  }
  const next = hostOp.then(wrapped, wrapped)
  hostOp = next.catch(() => {})
  return next
}

function windowHwnd(win) {
  const buf = win.getNativeWindowHandle()
  if (!buf || buf.length < 4) return 0
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0))
  return buf.readUInt32LE(0)
}

function prepareCompositor(win) {
  if (!win || win.isDestroyed()) return
  setNativeVideoCompositor(win, true)
  const hwnd = windowHwnd(win)
  if (hwnd) hwndHelper.prepareParent(hwnd)
}

async function startEngine(engine, url, startTime, bounds, win, opts = {}) {
  if (engine === 'libmpv') {
    prepareCompositor(win)
    libmpv.setMainWindow(win)
    const result = libmpv.start(win, url, startTime, bounds)
    if (result?.ok) {
      activeEngine = 'libmpv'
      markPlaybackActive(true)
      try {
        overlay.resume()
      } catch {
        // ignore
      }
      log.info('host', 'engine started', { engine: 'libmpv' })
      return result
    }
    setNativeVideoCompositor(win, false)
    return result
  }
  if (engine === 'mpv') {
    prepareCompositor(win)
    mpvExe.setMainWindow(win)
    const result = await mpvExe.start(win, url, startTime, bounds)
    if (result?.ok) {
      activeEngine = 'mpv'
      markPlaybackActive(true)
      try {
        overlay.resume()
      } catch {
        // ignore
      }
      log.info('host', 'engine started', { engine: 'mpv' })
      return result
    }
    setNativeVideoCompositor(win, false)
    return result
  }
  if (engine === 'mpv-one') {
    prepareCompositor(win)
    mpvOne.setMainWindow(win)
    // Controles só após 1º frame (overlay.show no motor) — senão cobre o % de buffer
    const result = await mpvOne.start(win, url, startTime, bounds)
    if (result?.ok) {
      activeEngine = 'mpv-one'
      markPlaybackActive(true)
      try {
        overlay.resume()
      } catch {
        // ignore
      }
      log.info('host', 'engine started', { engine: 'mpv-one' })
      return result
    }
    setNativeVideoCompositor(win, false)
    return result
  }
  if (engine === 'stur') {
    prepareCompositor(win)
    stur.setMainWindow(win)
    const result = await stur.start(win, url, startTime, bounds, { live: opts.live === true })
    if (result?.ok) {
      activeEngine = 'stur'
      markPlaybackActive(true)
      log.info('host', 'engine started', { engine: 'stur', live: opts.live === true })
      return result
    }
    log.warn('host', 'stur start failed', { live: opts.live === true, reason: result?.reason })
    setNativeVideoCompositor(win, false)
    return result
  }
  if (engine === 'mpeg') {
    prepareCompositor(win)
    mpeg.setMainWindow(win)
    const result = await mpeg.start(win, url, startTime, bounds, { live: opts.live === true, title: opts.title })
    if (result?.ok) {
      activeEngine = 'mpeg'
      markPlaybackActive(true)
      log.info('host', 'engine started', { engine: 'mpeg', live: opts.live === true })
      return result
    }
    log.warn('host', 'mpeg start failed', { live: opts.live === true, reason: result?.reason })
    setNativeVideoCompositor(win, false)
    return result
  }
  if (engine === 'vlc' || engine === 'mpc') {
    const result = await external.start(engine, url, startTime, win, { minimize: true })
    if (result?.ok) {
      activeEngine = engine
      overlay.hide()
      emit(win, { type: 'ready' })
      emit(win, { type: 'playing' })
      log.info('host', 'engine started', { engine })
      return result
    }
    return result
  }
  return { ok: false, error: `Engine desconhecido: ${engine}` }
}

function emit(win, payload) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('player:event', payload)
}

/*
 * `mode` carrega a INTENCAO do seek, nao o valor.
 *
 * O renderer manda `relative` quando o gesto e um salto ("anda 10s daqui"), e o
 * motor aplica a partir da posicao real dele. Sem isso, o salto virava seek
 * absoluto para um instante calculado no renderer — que chega atrasado em
 * relacao ao mpv. Seek para tras no mpv descarta o buffer e volta a rede.
 */
async function command(op, value, mode) {
  // Sem este registro o meio da cadeia e um buraco: da para ver que o
  // renderer pediu e que o motor nao recebeu, sem saber QUAL dos dois
  // intrumentos esta mentindo.
  if (op === 'seek') {
    log.info('host', 'seek recebido', { op, value, mode, engine: activeEngine })
  }
  if (activeEngine === 'libmpv') return libmpv.command(op, value, mode)
  if (activeEngine === 'mpv') return mpvExe.command(op, value, mode)
  if (activeEngine === 'mpv-one') return mpvOne.command(op, value, mode)
  if (activeEngine === 'stur') return stur.command(op, value, mode)
  if (activeEngine === 'mpeg') return mpeg.command(op, value, mode)
  return { ok: false }
}

async function setBounds(rect) {
  // Sync de geometria é passivo. Antes, com playback inativo, rodava o teardown
  // inteiro: bumpHostEpoch() + abortActiveLoad() + overlay.hide() + stops em
  // todos os motores. `player:set-bounds` chega de um ResizeObserver
  // (overlayBridge.watchVideoBounds) e de App.tsx em cada `fullscreenchange`.
  // Resultado: o container redimensionava durante um `player:start` em voo →
  // epoch bumpara → o start era cancelado, e o renderer recebia
  // {ok:false, cancelled:true} — que playerManager trata como SUCESSO (só
  // testa `=== false`). O usuário ficava 30s de spinner.
  if (!rect || !(rect.width >= 32) || !(rect.height >= 32)) {
    if (playbackActive) hideSurfaces()
    return { ok: true }
  }
  if (!playbackActive) return { ok: true }
  const win = getMainWindow()
  if (activeEngine === 'libmpv') libmpv.setBounds(rect)
  else if (activeEngine === 'mpv') mpvExe.setBounds(rect)
  else if (activeEngine === 'mpv-one') mpvOne.setBounds(rect)
  else if (activeEngine === 'stur') stur.setBounds(rect)
  else if (activeEngine === 'mpeg') mpeg.setBounds(rect)
  if (win && activeEngine) {
    overlay.syncBounds(rect)
  }
  return { ok: true }
}

function preloadStur(win) {
  // Só registra a janela — warm() na abertura criava HWND mpv preto cobrindo a UI React.
  try {
    stur.setMainWindow(win)
  } catch {
    // ignore
  }
}

/** Garante fundo opaco e HWND mpv escondido (startup / voltar da reprodução). */
function ensureShellVisible() {
  return hideSurfacesFast()
}

function setMainWindow(win) {
  boundWindow = win
  libmpv.setMainWindow(win)
  mpvExe.setMainWindow(win)
  mpvOne.setMainWindow(win)
  stur.setMainWindow(win)
  mpeg.setMainWindow(win)
  overlay.bindParent(win)
  bindFullscreenHooks(win)
  bindFocusHooks(win)
  ensureShellVisible()
  preloadStur(win)
  win.on('closed', () => {
    void stopAll()
    overlay.destroy()
    boundWindow = null
  })
}

async function openFile(payload = {}) {
  const { path: filePath, url, engine = 'libmpv', startTime = 0, bounds: customBounds } = payload
  const playUrl = normalizePlayUrl(url || filePath)
  if (!playUrl || !isPlayableUrl(playUrl)) {
    return { ok: false, error: 'Caminho ou URL inválido' }
  }
  const win = getMainWindow()
  if (!win) return { ok: false, error: 'Janela indisponível' }
  const cb = win.getContentBounds()
  const bounds = customBounds || { x: 0, y: 0, width: cb.width, height: Math.max(400, cb.height) }
  await stopAll()
  log.info('open', 'player:open', { engine, playUrl })

  if (engine === 'auto') {
    for (const candidate of ['mpv', 'libmpv', 'vlc', 'mpc']) {
      const result = await startEngine(candidate, playUrl, startTime, bounds, win)
      if (result?.ok) {
        log.info('open', 'auto success', { engine: candidate })
        return { ...result, engine: candidate }
      }
      await stopAll()
      log.warn('open', 'auto try failed', { engine: candidate, error: result?.error })
    }
    log.error('open', 'auto chain failed', { playUrl })
    return { ok: false, error: 'Cadeia automática falhou (mpv → libmpv → vlc → mpc)' }
  }

  const result = await startEngine(engine, playUrl, startTime, bounds, win)
  if (result?.ok) log.info('open', 'engine started', { engine, playUrl })
  else log.error('open', 'failed', { engine, error: result?.error })
  return result
}

function registerPlayerIpc() {
  ipcMain.handle('player:detect', () => detect())

  ipcMain.handle('player:hide', () => hideSurfaces())
  ipcMain.on('player:hide-sync', () => {
    hideSurfacesFast()
  })
  ipcMain.on('player:restore-shell', () => {
    hideSurfaces()
  })

  ipcMain.handle('player:start', async (_event, payload) => {
    const { engine, url, startTime, bounds, live, aspect } = payload || {}
    // Zap rápido ao vivo: cancela fila de reloads antigos (só o último canal importa).
    if (engine === 'stur' && live === true && stur.isRunning()) {
      bumpHostEpoch()
      stur.abortActiveLoad()
    }
    // MPEG no zap: mesmo processo, loadfile novo (sem matar mpv).
    if (engine === 'mpeg' && mpeg.isRunning()) {
      bumpHostEpoch()
      mpeg.abortActiveLoad()
    }
    return runHostOp(async () => {
      const playUrl = normalizePlayUrl(url)
      if (!playUrl || !isPlayableUrl(playUrl)) {
        return { ok: false, error: 'URL inválida' }
      }
      const win = getMainWindow()
      if (!win) return { ok: false, error: 'Janela indisponível' }
      const opts = { live: live === true, aspect: aspect }

      if (engine === 'stur' && stur.isRunning()) {
        const fast = await stur.reload(win, playUrl, startTime, bounds, opts)
        if (fast?.ok) {
          prepareCompositor(win)
          activeEngine = 'stur'
          markPlaybackActive(true)
          if (bounds) overlay.syncBounds(bounds)
          log.info('host', 'stur reloaded', { url: playUrl.slice(0, 120), live: opts.live })
          return fast
        }
      }

      if (engine === 'mpeg' && mpeg.isRunning()) {
        const fast = await mpeg.reload(win, playUrl, startTime, bounds, opts)
        if (fast?.ok) {
          prepareCompositor(win)
          activeEngine = 'mpeg'
          markPlaybackActive(true)
          if (bounds) overlay.syncBounds(bounds)
          log.info('host', 'mpeg reloaded', { url: playUrl.slice(0, 120), live: opts.live })
          return fast
        }
      }

      await stopAll()
      return startEngine(engine, playUrl, startTime, bounds, win, opts)
    })
  })

  /** Dev/teste: abre arquivo local ou URL direto no engine escolhido. */
  ipcMain.handle('player:open', async (_event, payload) => openFile(payload))

  ipcMain.handle('player:stop', async () => runHostOp(() => stopAll()))

  ipcMain.handle('player:command', async (_event, op, value, mode) => command(op, value, mode))

  ipcMain.handle('player:set-bounds', async (_event, rect) => setBounds(rect))

  ipcMain.handle('overlay:show', async (_event, rect, meta) => {
    const win = getMainWindow()
    if (!win) return { ok: false }
    return overlay.show(win, rect, meta)
  })

  ipcMain.handle('overlay:hide', async () => overlay.hide())

  ipcMain.handle('overlay:sync-bounds', async (_event, rect) => {
    overlay.syncBounds(rect)
    return { ok: true }
  })

  ipcMain.handle('overlay:set-meta', async (_event, meta) => {
    overlay.setMeta(meta || {})
    return { ok: true }
  })

  ipcMain.handle('overlay:set-list-open', async (_event, open) => {
    overlay.setListPanelOpen(open === true)
    return { ok: true }
  })

  ipcMain.handle('overlay:set-ignore-mouse', async (_event, ignore) => {

    overlay.setIgnoreMouse(ignore === true)
    return { ok: true }
  })



  ipcMain.handle('overlay:action', async (event, action) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    const win =
      getMainWindow() ||
      (senderWin && !senderWin.isDestroyed() ? senderWin.getParentWindow() : null)
    if (!win || win.isDestroyed()) return { ok: false }
    // DIAGNOSTICO do ESC. O overlay decide o que o ESC faz lendo o campo
    // `fullscreen` do meta. Se esse campo divergir do estado real da janela, o
    // ESC faz a coisa errada - e o sintoma e "apertei ESC e o video sumiu".
    //
    // Filtrado de proposito: arrastar o volume gerava 23 linhas seguidas de
    // `type: 'volume'` e enterrava o resto. So interessa `back` (o ramo que
    // derruba o video) e qualquer caso em que os dois lados discordam — que e
    // exatamente o bug.
    //
    // Atras de `STPLAY_FS_DEBUG` porque isto e ruido para quem so quer usar o
    // app: sao tres chamadas de log por acao de overlay, e o filtro acima so
    // deixa passar `back` e divergencia — ou seja, num uso normal quase nada
    // passa, mas o `try` ainda roda e o custo fica.
    if (process.env.STPLAY_FS_DEBUG) {
      try {
        const dica = overlay.getFullscreenHint?.() ?? null
        const real = win.isFullScreen()
        if (action?.type === 'back' || dica !== real) {
          log.info('fs', 'overlay action', {
            type: action?.type,
            overlayAchaFullscreen: dica,
            janelaRealFullscreen: real,
          })
        }
      } catch {
        // ignore
      }
    }
    try {
      win.webContents.send('player:overlay-action', action)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('overlay:ui', async (_event, payload) => {
    if (payload?.action === 'escape') {
      // Durante boot o overlay está escondido (lastRect null) — Esc precisa voltar no App
      const win = getMainWindow()
      if (win && !win.isDestroyed() && !overlay.canReshow?.()) {
        try {
          win.webContents.send('player:overlay-action', { type: 'back' })
        } catch {
          // ignore
        }
        return { ok: true }
      }
      overlay.reshow()
    }
    overlay.sendUi(payload || {})
    return { ok: true }
  })

  ipcMain.handle('overlay:ui-fullscreen', () => {
    const win = getMainWindow()
    // DIAGNOSTICO: o botao de sair da tela cheia do overlay cai aqui. Log do
    // estado real no instante do clique, porque o caminho passa pelo renderer
    // (`toggleFullscreen`) e um erro la dentro nao aparece em lugar nenhum.
    //
    // Atras de `STPLAY_FS_DEBUG` pelo mesmo motivo do bloco acima.
    if (process.env.STPLAY_FS_DEBUG) {
      try {
        log.info('fs', 'ui-fullscreen pedido', {
          janelaRealFullscreen: win && !win.isDestroyed() ? win.isFullScreen() : null,
        })
      } catch {
        // ignore
      }
    }
    if (win && !win.isDestroyed()) {
      /*
        O MAIN inverte, e nao o renderer.

        Medido pelo dono, no log com `STPLAY_FS_DEBUG`, cinco cliques seguidos no
        botao de tela cheia:

          ui-fullscreen pedido { janelaRealFullscreen: true }
          apply pedido { pedido: true, estadoReal: true }   <- PEDIU PARA ENTRAR

        A janela ja estava em tela cheia e o renderer pediu para ENTRAR. Cada
        `setFullScreen(true)` redundante reexecuta a transicao: a janela quica, o
        `isFullScreen()` pisca, o renderer recebe o pisca e continua defasado - e o
        clique seguinte pede para entrar de novo. O sintoma na tela e "clicou em
        tela cheia e ela pisca".

        Por que o renderer erra: ele decide com `winFsRef.current`, um espelho do
        IPC `window:fullscreen-changed`. E esse espacao OSCILA junto com a janela.
        O `toggleFullscreen` do renderer foi escrito justamente para nao depender
        de estado do render - mas a verdade de que ele precisa (`windowFullscreen`)
        continua vindo de la, e la chega atrasada.

        Quem nao adivinha e o main: `win.isFullScreen()` e a leitura ao vivo. O F11
        ja fazia assim (`applyWindowFullscreen(win, !win.isFullScreen())`) e nunca
        travou. O botao do overlay agora usa o mesmo caminho.

        O renderer nao e avisado de proposito: se ele tambem invertesse, seriam duas
        inversoes no mesmo toque e o saldo seria zero. Ele continua recebendo o
        resultado pelo `window:fullscreen-changed`, que e o que alimenta o rotulo
        do botao e o `body.player-active`.
      */
      applyWindowFullscreen(win, !win.isFullScreen())
    }
    return { ok: true }
  })

  ipcMain.handle('overlay:ui-key', (_event, payload) => {
    const win = getMainWindow()
    /*
      F11 vindo do overlay: inverte aqui, como o botao de tela cheia.

      E o mesmo defeito do botao, pelo mesmo caminho: o renderer recebe a tecla,
      chama `toggleFullscreen()`, e o `toggleFullscreen` decide com `winFsRef` -
      um espelho que OSCILA junto com a janela. Medido no log do dono: a janela em
      tela cheia e o renderer pedindo para ENTRAR, cinco vezes seguidas.

      O F11 da janela principal ja nao passa por aqui - ele e resolvido no
      `before-input-event`, que le `win.isFullScreen()` ao vivo. O do overlay
      chegava por aqui e caia no renderer. Agora os dois usam a mesma verdade.
    */
    const key = payload && typeof payload.key === 'string' ? payload.key : ''
    if (key === 'F11') {
      if (win && !win.isDestroyed()) {
        applyWindowFullscreen(win, !win.isFullScreen())
      }
      return { ok: true }
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('player:ui-key', payload || {})
    }
    return { ok: true }
  })

  ipcMain.handle('native-player:detect', () => detect())

  ipcMain.handle('native-player:stop', async () => stopAll())

  ipcMain.handle('native-player:stop-external', async () => {
    external.stop()
    return { ok: true }
  })

  ipcMain.handle('native-player:focus', () => {
    const pid = external.getPid()
    if (pid) external.focusExternal(pid)
    return { ok: true }
  })

  ipcMain.handle('window:set-fullscreen', (_event, enabled) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { ok: false }
    return applyWindowFullscreen(win, enabled === true)
  })

  ipcMain.handle('window:is-fullscreen', () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { ok: false, fullscreen: false, origin: null }
    return { ok: true, fullscreen: win.isFullScreen(), origin: fullscreenOrigin }
  })
}

/**
 * Quem mandou a janela entrar em tela cheia.
 *
 * `null`  = ninguem, e o padrao
 * `'app'` = o app estava em tela cheia antes do video (F11 do dono, ou ele mesmo
 *           ja em tela cheia e abriu um canal)
 * `'player'` = o botao de tela cheia da barra, ou seja, o VIDEO trouxe a janela
 *
 * O `back` usa isso: se a tela cheia era do dono, o `back` so para o video e
 * mantem a janela em tela cheia. Se foi o video, o `back` devolve a janela ao
 * modo em que ela estava.
 *
 * Medido: com a checagem no renderer, o video subindo em um app que JA estava em
 * tela cheia nao gerava evento nenhum — o espelho do renderer continuava `false`
 * e o `back` tirava a janela de tela cheia de um video que o usuario nao pediu
 * para sair. Quem tem de saber nao e o renderer: e o main, que ve a ordem real.
 */
let fullscreenOrigin = null

function applyWindowFullscreen(win, enabled) {
  const next = enabled === true
  /*
    Guarda a origem ANTES de aplicar.

    `playbackActive` e o sinal certo: ele e explicitamente ligado no `start` do
    motor e desligado no `stop`. `activeEngine` nao serve — continua preenchido
    entre um video e outro, e um F11 com o catalogo aberto era lido como video.
  */
  fullscreenOrigin = next ? (playbackActive ? 'player' : 'app') : null
  if (process.env.STPLAY_FS_DEBUG) {
    // QUEM esta pedindo a troca, e com que verdade.
    //
    // O log de `aplicarEstadoReal` so mostrava a janela OSCILANDO sem dizer quem
    // a estava derrubando. Este e o outro lado: se `pedido` divergir do estado
    // real, ha alguem chamando com valor velho - e o `setFullScreen` com valor
    // repetido e, no Windows, capaz de derrubar a janela de tela cheia.
    try {
      log.info('fs', 'apply pedido', {
        pedido: next,
        estadoReal: !win.isDestroyed() ? win.isFullScreen() : null,
        playbackActive,
        engine: activeEngine,
      })
    } catch {
      // ignore
    }
  }
  try {
    if (next) {
      win.setFullScreen(true)
      /*
        Nivel normal, nao 'screen-saver': o 'screen-saver' minimizava a janela na
        entrada (medido: -32000,-32000 mesmo com `setFullScreen` puro antes, o
        problema era o nivel aplicado em seguida). O nivel normal cobre a taskbar
        durante o fullscreen sem sequestrar a janela.
      */
      win.setAlwaysOnTop(true)
    } else {
      win.setAlwaysOnTop(false)
      win.setFullScreen(false)
      /*
        Sair de tela cheia minimizava a janela (medido: 160x28 em -32000,-32000).
        A janela nasce com `show: false` e so aparece no `ready-to-show`; ao sair
        do fullscreen o Electron a devolve ao estado "nao mostrada". O `show()`
        apos a saida a mantem visivel em modo janela.
      */
      if (!win.isVisible()) win.show()
      /*
        RE-MEDIR DEPOIS DA SAIDA.

        O `refreshNativeFullscreenLayout` de cima so corre enquanto a janela ESTA
        em tela cheia - ele e quem posiciona a superficie no tamanho cheio. Na
        saida ele nao serve, e ninguem posicionava de volta: a janela voltava ao
        modo janela e a superficie do mpv ficava GIGANTE, do tamanho da tela
        cheia, cobrindo o catalogo e recebendo clique ate fora do app. Medido
        pelo dono: "fica em tela cheia soq em modo janela quando volta do full" e
        "clico embaixo sem ser no app e mesmo assim ele pausa".

        Quem sabe o retangulo novo e o RENDERER - o `getBoundingClientRect` do
        wrapper do player, que so existe la. O main nao tem esse numero.

        A ponde ja existia: `player:window-moved` faz o `playerManager` chamar
        `reconciliar()`, que re-mede o retangulo e reenvia por `setBounds`. E o
        mesmo caminho usado quando a janela troca de monitor. Reaproveito, no
        mesmo atraso do foco: 220 ms, para a janela ja ter assentado.
      */
      setTimeout(() => {
        if (win.isDestroyed() || !win.isVisible()) return
        try {
          win.moveTop()
        } catch {
          // ignore
        }
        try {
          win.focus()
        } catch {
          // ignore
        }
        try {
          win.webContents.send('player:window-moved')
        } catch {
          // ignore
        }
      }, 220)
    }
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (win.isDestroyed()) return
    refreshNativeFullscreenLayout(win)
  }, 50)
  setTimeout(() => {
    if (win.isDestroyed()) return
    refreshNativeFullscreenLayout(win)
  }, 200)
  /*
   * Confirmacao do estado de tela cheia, em 250 ms e 700 ms.
   *
   * `applyWindowFullscreen` so PEDE; quem confirma e o `leave-full-screen`, e ele
   * dispara no inicio da animacao. Se `win.isFullScreen()` ainda responder `true`
   * nesse instante, o renderer fica com `winFs: true`, `player-active` fica
   * ligado, e o browse inteiro some sem a pessoa pedir. Confirmar duas vezes com
   * folga fecha a janela em que isso acontece.
   */
  if (typeof win.__sturReconciliarFullscreen === 'function') {
    setTimeout(win.__sturReconciliarFullscreen, 250)
    setTimeout(win.__sturReconciliarFullscreen, 700)
  }
  return { ok: true, fullscreen: win.isFullScreen() }
}

function refreshNativeFullscreenLayout(win) {
  if (!win || win.isDestroyed() || !activeEngine) return
  if (!win.isFullScreen()) {
    if (process.env.STPLAY_FS_DEBUG) {
      try {
        log.info('fs', 'bail: janela ainda nao esta em tela cheia', { engine: activeEngine })
      } catch { /* ignore */ }
    }
    return
  }
  if (activeEngine !== 'stur' && activeEngine !== 'mpeg' && activeEngine !== 'mpv-one' && activeEngine !== 'mpv' && activeEngine !== 'libmpv') {
    return
  }
  try {
    const cb = win.getContentBounds()
    if (process.env.STPLAY_FS_DEBUG) {
      try {
        log.info('fs', 'reposicionando', {
          engine: activeEngine,
          cbX: cb.x, cbY: cb.y, cbW: cb.width, cbH: cb.height,
          limiteAntes: lastBounds ? { w: lastBounds.width, h: lastBounds.height } : null,
        })
      } catch { /* ignore */ }
    }
    const full = {
      x: 0,
      y: 0,
      width: Math.max(64, cb.width),
      height: Math.max(64, cb.height),
    }
    void setBounds(full)
    overlay.relayoutToParent()
  } catch {
    // ignore
  }
}

function bindFocusHooks(win) {
  if (!win || win.isDestroyed() || win.__sturFocusBound) return
  win.__sturFocusBound = true
  let timer = null
  const onLayout = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (win.isDestroyed() || !activeEngine) return
      if (win.isFullScreen()) {
        refreshNativeFullscreenLayout(win)
        overlay.relayoutToParent()
      }
      try {
        if (activeEngine === 'stur') stur.refreshLayout()
        else if (activeEngine === 'mpeg') mpeg.refreshLayout()
        else if (activeEngine === 'mpv-one') mpvOne.refreshLayout()
      } catch {
        // ignore
      }
    }, 80)
  }
  win.on('show', onLayout)
  win.on('restore', onLayout)
  win.on('maximize', onLayout)
  win.on('unmaximize', onLayout)
}

function bindFullscreenHooks(win) {
  if (!win || win.isDestroyed() || win.__sturFullscreenBound) return
  win.__sturFullscreenBound = true
  /*
   * Ultimo valor de tela cheia EMITIDO para o renderer.
   *
   * O renderer deriva `isFs` deste evento, e `isFs` e o que liga
   * `body.player-active`, que esconde o browse inteiro. Um evento perdido ou
   * atrasado nao da um glitch passageiro: deixa a classe ligada para sempre, e a
   * unica saida passa a ser o ESC - que segue outro caminho.
   */
  let ultimoEnviado = null
  /*
   * O mesmo valor, empurrado para o OVERLAY.
   *
   * O overlay decide o que o ESC faz por um campo `fullscreen`, e esse campo
   * chegava do RENDERER (`setOverlayMeta({ fullscreen: isFs })`, com
   * `isFs = domFs || winFs`). O `winFs` do renderer OSCILA junto com a janela, e
   * o log do dono mostrou a consequencia:
   *
   *   overlay action { type: 'back',
   *                    overlayAchaFullscreen: false,
   *                    janelaRealFullscreen: false }
   *
   * O overlay achava que NAO estava em tela cheia, entao o ESC caiu no ramo
   * `back` - que PARA O VIDEO em vez de sair da tela cheia. Era o sintoma
   * "aperto esq e o video some junto".
   *
   * O comentario em `overlay-window.cjs` ja advertia: "se esse campo divergir do
   * estado real, o ESC para o VIDEO". E divergia, porque quem mandava era quem
   * nao tinha a verdade.
   *
   * Agora o main - que le `win.isFullScreen()` ao vivo - e o dono do campo. Ele
   * empurra no mesmo lugar em que avisa o renderer, na transicao que sobreviveu
   * ao gate de estabilidade. O renderer continua podendo mandar o campo dele
   * para outras coisas, mas a VERDADE de tela cheia vem sempre por cima.
   */
  let ultimoHintOverlay = null
  const hintParaOverlay = (fs) => {
    if (ultimoHintOverlay === fs) return
    ultimoHintOverlay = fs
    try {
      overlay.setMeta({ fullscreen: fs })
    } catch {
      // ignore
    }
  }
  /*
   * Releitura adiada da transicao de tela cheia.
   *
   * MEDIDO num Electron 39 isolado (janela sem moldura, 900x600 -> F11):
   *
   *   evento: ENTER      isFullScreen=false  contentBounds=100,80 900x600
   *   evento: resize     isFullScreen=true   contentBounds=0,0 1920x1080
   *
   * O `enter-full-screen` dispara NO COMECO da animacao, e nesse instante a
   * janela ainda nao mudou: `isFullScreen()` devolve `false` e
   * `getContentBounds()` devolve o retangulo JANELADO. O `leave-full-screen` e o
   * mesmo defeito ao contrario — devolve `true` e o retangulo cheio.
   *
   * O evento mente nos dois sentidos, e o codigo que le ele na hora erra. Foi
   * assim que a saida ficou bugada (renderer preso em `winFs: true`) e, quando a
   * simetria foi "consertada", a entrada ficou: `refresh` no ENTER via
   * `isFullScreen() === false` e portanto
   *
   *   1. `enviar(false)` — o renderer recebe "nao estou em tela cheia" e nao
   *      liga `body.player-active`. A lista de canais fica visivel por cima do
   *      video, que e o sintoma do dono.
   *   2. `win.setAlwaysOnTop(false)` — derruba o always-on-top NA ENTRADA.
   *   3. `refreshNativeFullscreenLayout(win)` sai no primeiro guarda, porque
   *      `win.isFullScreen()` ainda e falso. O mpv fica com o retangulo velho,
   *      do tamanho do card, no meio da tela.
   *
   * A correcao e uma so, e vale para os dois eventos: nao decidir no evento.
   * Marca uma releitura para quando a animacao assentar, e quem manda e a
   * leitura real de depois. O debounce agrupa a enxurrada de `resize` que a
   * propria transicao gera.
   */
  let reconciliarTransicao = null

  /*
   * `refresh` so AGREGA. Ele nao decide mais nada.
   *
   * O `enter-full-screen`, o `leave-full-screen` e cada `resize` que a transicao
   * gera chegam aqui, e cada um merece a mesma resposta: esperar 90 ms e ler a
   * verdade. Antes cada um resolvia sozinho, e por isso cada um errava sozinho.
   */
  const refresh = () => {
    if (win.isDestroyed()) return
    if (reconciliarTransicao) clearTimeout(reconciliarTransicao)
    reconciliarTransicao = setTimeout(() => {
      reconciliarTransicao = null
      if (win.isDestroyed()) return
      aplicarEstadoReal()
    }, 90)
  }

  /*
   * Leitura ESTAVEL antes de emitir.
   *
   * `win.isFullScreen()` OSCILA durante a transicao no Windows, e o log do dono
   * provou com tres `true` seguidos - tres emissoes de `true` seguidas so
   * acontecem se `enviar(false)` rodou entre elas:
   *
   *   janela fullscreen { fullscreen: true }
   *   janela fullscreen { fullscreen: true }
   *   janela fullscreen { fullscreen: true }
   *
   * Uma leitura nao basta. Emitir no primeiro `false` que passa manda o renderer
   * para "nao estou em tela cheia", e no app isso apaga `body.player-active` e
   * some com o catalogo por alguns quadros - o "so pisca" que o dono relatou.
   *
   * A regra e: uma mudanca so existe se sobreviver a uma releitura. Duas
   * leituras iguais com 70 ms entre elas, no maximo oito tentativas - se a
   * oscilacao durar mais que isso, a ultima leitura vale, porque ficar
   * re-lendo para sempre e pior que uma emissao atrasada.
   */
  let ultimoLido = null
  let leiturasEstaveis = 0

  const avaliar = (tentativasRestantes) => {
    if (win.isDestroyed()) return
    try {
      const fs = win.isFullScreen()
      if (fs === ultimoLido) {
        leiturasEstaveis += 1
      } else {
        ultimoLido = fs
        leiturasEstaveis = 1
      }

      if (leiturasEstaveis >= 2 || tentativasRestantes <= 0) {
        leiturasEstaveis = 0
        /*
          So age quando o valor MUDA.

          `aplicarEstadoReal` e chamado do debounce de 90 ms e das confirmacoes de
          250/700 ms. A reonda de `refreshNativeFullscreenLayout` continua correndo
          sempre: ele e barato e e o que garante o mpv no lugar, mesmo que o
          estado nao tenha mudado desde a ultima vez.
        */
        if (ultimoEnviado !== fs) {
          // DIAGNOSTICO: toda mudanca de tela cheia da JANELA, com o valor real.
          // Sem isto nao da para dizer se o overlay foi avisado ou se so a janela
          // mudou.
          if (process.env.STPLAY_FS_DEBUG) {
            try {
              log.info('fs', 'janela fullscreen', { fullscreen: fs })
            } catch {
              // ignore
            }
          }
          enviar(fs)
          hintParaOverlay(fs)
        }
        refreshNativeFullscreenLayout(win)
        return
      }
      setTimeout(() => avaliar(tentativasRestantes - 1), 70)
    } catch {
      // ignore
    }
  }

  const aplicarEstadoReal = () => avaliar(8)
  win.__sturReconciliarFullscreen = aplicarEstadoReal

  /*
   * Re-lee o estado real e corrige o renderer se ele divergiu.
   *
   * O `leave-full-screen` dispara no COMECO da transicao, e no Windows ler
   * `win.isFullScreen()` nesse instante ainda pode devolver `true` porque a
   * animacao nao terminou. O evento dizia "saiu", a leitura dizia "nao saiu", e
   * o renderer guardava `winFs: true` - `player-active` ligado para sempre.
   *
   * Duas confirmacoes porque cada uma cobre um prazo diferente: 250 ms pega a
   * transicao normal, 700 ms pega a janela que estava no meio de um arrraste
   * quando a saida foi pedida.
   */
  /*
   * Confirmacoes do `applyWindowFullscreen`, em 250 ms e 700 ms.
   *
   * Cada uma pega um prazo diferente: 250 ms a transicao normal, 700 ms a janela
   * que estava no meio de um arraste quando a ordem chegou. As duas chamam
   * `aplicarEstadoReal`, que le a verdade e nao o evento.
   */
  win.__sturConfirmarFullscreenDepois = (ms) => {
    setTimeout(() => {
      if (!win.isDestroyed()) aplicarEstadoReal()
    }, ms)
  }

  win.on('enter-full-screen', refresh)
  win.on('leave-full-screen', refresh)
  win.on('resize', () => {
    refresh()
  })
  /*
   * MOVER a janela, sem redimensionar.
   *
   * O `resize` acima so reage em tela cheia, e o `move` nao existia. Medido no
   * sintoma do usuario: arrastar a janela para o segundo monitor deixava o
   * video cobrindo a janela inteira, e o `Refresh` nunca era chamado.
   *
   * Por que o renderer nao resolve sozinho: o `getBoundingClientRect` e
   * relativo ao viewport da JANELA, entao mover a janela nao muda x/y/w/h do
   * elemento. O `ResizeObserver` observa o elemento e tambem nao dispara — nada
   * mudou de tamanho. O retangulo publicado continua sendo o da tela anterior,
   * que e um numero obsoleto em coordenadas de tela.
   *
   * E o `refresh` do main nao conserta sozinho: `refreshLayout` reposiciona com
   * `lastBounds`, que e justamente o valor velho. O que precisa e o renderer
   * re-medir. Por isso os dois lados: aqui dispara, e o `overlayBridge` ignora
   * o cache de duplicata quando o evento vem de fora.
   *
   * `move` dispara durante o arraste, entao o `clearTimeout` agrupa: so o
   * ultimo vale. Sem isso, um arraste de 2s faria ~60 IPC por segundo.
   */
  let moverTimer = null
  win.on('move', () => {
    if (!activeEngine) return
    if (moverTimer) clearTimeout(moverTimer)
    moverTimer = setTimeout(() => {
      moverTimer = null
      if (!activeEngine) return
      try {
        win.webContents.send('player:window-moved')
      } catch {
        // ignore
      }
      if (activeEngine === 'stur') stur.refreshLayout()
      else if (activeEngine === 'mpeg') mpeg.refreshLayout()
      else if (activeEngine === 'mpv-one') mpvOne.refreshLayout()
    }, 120)
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape') {
      event.preventDefault()
      win.webContents.send('player:ui-key', { key: 'Escape' })
      return
    }
    /*
      F11 durante o playback.

      O renderer tratava F11 so quando `!useBufferedNative` — ou seja, o caminho
      NATIVO. No motor buffered (o padrao deste app), o `keydown` do PlayerView
      ignorava o F11 e ele nao tinha para onde ir. Medido: com video tocando, o
      F11 nao entrava nem saia de tela cheia.

      Aqui o main resolve, com ou sem player. E o main porque e o unico lugar que
      sabe se o F11 ja foi tratado: o `globalShortcut` tambem dispara F11, e dois
      caminhos invertendo a tela cheia no mesmo toque cancelariam.

      `applyWindowFullscreen` guarda a origem a partir de `playbackActive`, entao
      o `origin` continua correto para o `back` decidir se devolve a janela.
    */
    if (input.key === 'F11') {
      event.preventDefault()
      applyWindowFullscreen(win, !win.isFullScreen())
    }
  })
}

function preloadLibmpv(win) {
  try {
    libmpv.preload(win)
  } catch {
    // ignore
  }
}

function shutdownSync() {
  unregisterAllPlaybackShortcuts()
  activeEngine = null
  setNativeVideoCompositor(getMainWindow(), false)
  try {
    libmpv.stop({ immediate: true })
  } catch {
    // ignore
  }
  try {
    mpvExe.stop()
  } catch {
    // ignore
  }
  try {
    mpvOne.stop({ sync: true })
  } catch {
    // ignore
  }
  try {
    stur.stop({ sync: true })
  } catch {
    // ignore
  }
  try {
    mpeg.stop()
  } catch {
    // ignore
  }
  try {
    sturProxy.stop()
  } catch {
    // ignore
  }
  try {
    external.stop()
  } catch {
    // ignore
  }
  try {
    overlay.destroy()
  } catch {
    // ignore
  }
  try {
    libmpv.shutdown()
  } catch {
    // ignore
  }
}

function shutdown() {
  shutdownSync()
}

module.exports = {
  registerPlayerIpc,
  setMainWindow,
  preloadLibmpv,
  shutdown,
  shutdownSync,
  detect,
  stopAll,
  startEngine,
  openFile,
  ensureShellVisible,
}
