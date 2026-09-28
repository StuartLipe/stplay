const { ipcMain, BrowserWindow, globalShortcut } = require('electron')
const { findMpv } = require('../find-player.cjs')
const libmpv = require('./libmpv-player.cjs')
const mpvExe = require('./mpv-exe-player.cjs')
const mpvOne = require('./mpv-one-player.cjs')
const stur = require('./stur-player.cjs')
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
/** Só com a janela em foco — evita roubar F11 de outros apps. */
const FOCUS_ONLY_SHORTCUT_KEYS = ['F11']

function sendPlaybackKey(key) {
  if (!playbackActive) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    if (key === 'F11') {
      win.webContents.send('player:ui-fullscreen')
      return
    }
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
    if (!playbackActive) return
    registerPlaybackShortcuts()
    registerFocusOnlyShortcuts()
  })
  win.on('blur', () => {
    unregisterAllPlaybackShortcuts()
  })
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
// Transparente como o IPTV Player One — o HWND do mpv aparece sem “borda” opaca.
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

async function command(op, value) {
  if (activeEngine === 'libmpv') return libmpv.command(op, value)
  if (activeEngine === 'mpv') return mpvExe.command(op, value)
  if (activeEngine === 'mpv-one') return mpvOne.command(op, value)
  if (activeEngine === 'stur') return stur.command(op, value)
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
    const { engine, url, startTime, bounds, live } = payload || {}
    // Zap rápido ao vivo: cancela fila de reloads antigos (só o último canal importa).
    if (engine === 'stur' && live === true && stur.isRunning()) {
      bumpHostEpoch()
      stur.abortActiveLoad()
    }
    return runHostOp(async () => {
      const playUrl = normalizePlayUrl(url)
      if (!playUrl || !isPlayableUrl(playUrl)) {
        return { ok: false, error: 'URL inválida' }
      }
      const win = getMainWindow()
      if (!win) return { ok: false, error: 'Janela indisponível' }
      const opts = { live: live === true }

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

      await stopAll()
      return startEngine(engine, playUrl, startTime, bounds, win, opts)
    })
  })

  /** Dev/teste: abre arquivo local ou URL direto no engine escolhido. */
  ipcMain.handle('player:open', async (_event, payload) => openFile(payload))

  ipcMain.handle('player:stop', async () => runHostOp(() => stopAll()))

  ipcMain.handle('player:command', async (_event, op, value) => command(op, value))

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
    if (win && !win.isDestroyed()) {
      win.webContents.send('player:ui-fullscreen')
    }
    return { ok: true }
  })

  ipcMain.handle('overlay:ui-key', (_event, payload) => {
    const win = getMainWindow()
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
    if (!win || win.isDestroyed()) return { ok: false, fullscreen: false }
    return { ok: true, fullscreen: win.isFullScreen() }
  })
}

function applyWindowFullscreen(win, enabled) {
  const next = enabled === true
  try {
    win.setFullScreen(next)
    if (next) {
      // Cobre a taskbar do Windows (sem isso o F11 deixa a barra visível)
      win.setAlwaysOnTop(true, 'screen-saver')
    } else {
      win.setAlwaysOnTop(false)
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
  return { ok: true, fullscreen: win.isFullScreen() }
}

function refreshNativeFullscreenLayout(win) {
  if (!win || win.isDestroyed() || !activeEngine) return
  if (!win.isFullScreen()) return
  if (activeEngine !== 'stur' && activeEngine !== 'mpv-one' && activeEngine !== 'mpv' && activeEngine !== 'libmpv') {
    return
  }
  try {
    const cb = win.getContentBounds()
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
  const refresh = () => {
    if (win.isDestroyed()) return
    const fs = win.isFullScreen()
    try {
      win.webContents.send('window:fullscreen-changed', { fullscreen: fs })
    } catch {
      // ignore
    }
    if (!fs) {
      try {
        win.setAlwaysOnTop(false)
      } catch {
        // ignore
      }
    }
    refreshNativeFullscreenLayout(win)
  }
  win.on('enter-full-screen', refresh)
  win.on('leave-full-screen', refresh)
  win.on('resize', () => {
    if (win.isFullScreen() && activeEngine) refresh()
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    // F11: só via globalShortcut com janela em foco (evita duplo-toggle com keydown do renderer)
    if (input.key === 'Escape') {
      event.preventDefault()
      win.webContents.send('player:ui-key', { key: 'Escape' })
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
