/**
 * libmpv embutido (koffi) — vídeo dentro da janela Electron via wid/HWND.
 * Start rápido: DLL pré-carregada, ctx reutilizado, gpu-hq lazy após 1º frame.
 */
const path = require('path')
const fs = require('fs')
const koffi = require('koffi')
const log = require('./player-log.cjs')
const overlay = require('./overlay-window.cjs')
const hwndHelper = require('./hwnd-helper.cjs')
const { isPlayableUrl } = require('./play-url.cjs')

const MPV_FORMAT_FLAG = 3
const MPV_FORMAT_INT64 = 4
const MPV_FORMAT_DOUBLE = 5

const MPV_EVENT_NONE = 0
const MPV_EVENT_SHUTDOWN = 1
const MPV_EVENT_START_FILE = 6
const MPV_EVENT_END_FILE = 7
const MPV_EVENT_FILE_LOADED = 8
const MPV_EVENT_PLAYBACK_RESTART = 21

const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_CLIPCHILDREN = 0x02000000
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040
const SW_HIDE = 0
const SW_SHOW = 5

const MpvEvent = koffi.struct('stplay_mpv_event', {
  event_id: 'int',
  error: 'int',
  reply_userdata: 'uint64',
  data: 'void *',
})

/** @type {any} */
let mpv = null
/** @type {any} */
let user32 = null
/** @type {any} */
let ctx = null
/** @type {bigint} */
let hostHwnd = 0n
/** @type {bigint} */
let parentHwnd = 0n
/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let raiseTimer = null
/** @type {{ x: number, y: number, width: number, height: number } | null} */
let lastBounds = null
let playUrl = ''
let pendingSeek = 0
let running = false
let qualityBoosted = false
let dllPreloaded = false
/** Bump força recreate do ctx aquecido quando a receita muda */
const LIBMPV_CONFIG_REV = 12
let appliedConfigRev = 0
/** @type {number} */
let loadStartedAt = 0

function resolveDll() {
  const names = ['libmpv-2.dll', 'mpv-2.dll', 'mpv.dll']
  const roots = [
    path.join(__dirname, '..', '..', 'vendor', 'players', 'libmpv'),
    path.join(__dirname, '..', '..', 'vendor', 'players', 'mpv'),
    path.join(process.resourcesPath || '', 'players', 'libmpv'),
    path.join(process.resourcesPath || '', 'players', 'mpv'),
    path.join(path.dirname(process.execPath), 'players', 'libmpv'),
    path.join(path.dirname(process.execPath), 'resources', 'players', 'libmpv'),
  ]
  for (const root of roots) {
    for (const name of names) {
      const full = path.join(root, name)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}

function isAvailable() {
  return Boolean(resolveDll())
}

function loadApis() {
  if (mpv && user32) {
    dllPreloaded = true
    return true
  }
  const dllPath = resolveDll()
  if (!dllPath) return false

  const lib = koffi.load(dllPath)
  mpv = {
    create: lib.func('void *mpv_create()'),
    initialize: lib.func('int mpv_initialize(void *ctx)'),
    destroy: lib.func('void mpv_terminate_destroy(void *ctx)'),
    setOptionString: lib.func('int mpv_set_option_string(void *ctx, const char *name, const char *data)'),
    setPropertyString: lib.func('int mpv_set_property_string(void *ctx, const char *name, const char *data)'),
    commandString: lib.func('int mpv_command_string(void *ctx, const char *args)'),
    observeProperty: lib.func('int mpv_observe_property(void *ctx, uint64_t reply_userdata, const char *name, int format)'),
    waitEvent: lib.func('stplay_mpv_event *mpv_wait_event(void *ctx, double timeout)'),
    getProperty: lib.func('int mpv_get_property(void *ctx, const char *name, int format, _Out_ void *data)'),
    errorString: lib.func('const char *mpv_error_string(int error)'),
  }

  const u32 = koffi.load('user32.dll')
  user32 = {
    CreateWindowExW: u32.func(
      'uintptr CreateWindowExW(uint32_t dwExStyle, str16 lpClassName, str16 lpWindowName, uint32_t dwStyle, int x, int y, int nWidth, int nHeight, uintptr hWndParent, uintptr hMenu, uintptr hInstance, void *lpParam)',
    ),
    DestroyWindow: u32.func('int DestroyWindow(uintptr hWnd)'),
    SetWindowPos: u32.func(
      'int SetWindowPos(uintptr hWnd, uintptr hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)',
    ),
    ShowWindow: u32.func('int ShowWindow(uintptr hWnd, int nCmdShow)'),
  }
  dllPreloaded = true
  console.log('[libmpv] DLL carregada:', dllPath)
  return true
}

/**
 * Pré-carrega a DLL no boot (sem custo na 1ª reprodução).
 * Com janela: também aquece create+initialize+HWND.
 */
function preload(win = null) {
  if (!loadApis()) return { ok: false, error: 'libmpv-2.dll não encontrada' }
  if (win && !win.isDestroyed()) {
    mainWindow = win
    try {
      ensureWarmContext(win)
      return { ok: true, warmed: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'warm falhou' }
    }
  }
  return { ok: true, warmed: false }
}

function errorMessage(code) {
  try {
    return mpv.errorString(code) || `mpv ${code}`
  } catch {
    return `mpv ${code}`
  }
}

function windowHwnd(win) {
  const buf = win.getNativeWindowHandle()
  if (!buf || buf.length < 4) return 0n
  if (buf.length >= 8) return buf.readBigUInt64LE(0)
  return BigInt(buf.readUInt32LE(0))
}

function scaleFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1
  try {
    const { screen } = require('electron')
    return screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor || 1
  } catch {
    return 1
  }
}

function emit(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const map = {
    loaded: { type: 'ready' },
    playing: { type: 'playing' },
    pause: (v) => ({ type: v ? 'paused' : 'playing' }),
    time: (v) => ({ type: 'timeupdate', current: v }),
    duration: (v) => ({ type: 'duration', value: v }),
    buffer: (v) => ({ type: 'buffering', value: v > 0 && v < 100 }),
    error: (v) => ({ type: 'failed', reason: String(v || 'libmpv error') }),
    eof: { type: 'ended' },
    stopped: { type: 'stopped' },
  }
  let out = payload
  if (payload?.type && map[payload.type]) {
    const mapped = map[payload.type]
    out = typeof mapped === 'function' ? mapped(payload.value) : { ...mapped }
  }
  mainWindow.webContents.send('player:event', out)
  mainWindow.webContents.send('native-player:event', payload)
}

function destroyHost() {
  if (!hostHwnd) return
  try {
    user32.DestroyWindow(Number(hostHwnd))
  } catch {
    // ignore
  }
  hostHwnd = 0n
  parentHwnd = 0n
}

function ensureHost(parent) {
  if (hostHwnd && parentHwnd === parent) return hostHwnd
  destroyHost()
  parentHwnd = parent
  const hwnd = user32.CreateWindowExW(
    0,
    'STATIC',
    'STPLAY-LIBMPV',
    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    0,
    0,
    64,
    64,
    Number(parent),
    0,
    0,
    null,
  )
  if (!hwnd) throw new Error('Falha ao criar HWND host do libmpv')
  hostHwnd = BigInt(hwnd)
  void hwndHelper.prepareParent(Number(parent))
  return hostHwnd
}

function placeHost(bounds) {
  if (!hostHwnd) return
  const b = bounds || lastBounds
  if (!b || b.width < 32 || b.height < 32) return
  lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
  const s = scaleFactor()
  const x = Math.round(b.x * s)
  const y = Math.round(b.y * s)
  const w = Math.max(64, Math.round(b.width * s))
  const h = Math.max(64, Math.round(b.height * s))
  user32.SetWindowPos(Number(hostHwnd), 0, x, y, w, h, SWP_SHOWWINDOW | SWP_NOACTIVATE)
  user32.ShowWindow(Number(hostHwnd), SW_SHOW)
  if (parentHwnd) {
    void hwndHelper.prepareParent(Number(parentHwnd))
    void hwndHelper.childRaise(Number(hostHwnd))
  }
}

function hideHost() {
  if (!hostHwnd) return
  try {
    user32.ShowWindow(Number(hostHwnd), SW_HIDE)
  } catch {
    // ignore
  }
}

function clearTimers() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (raiseTimer) {
    clearInterval(raiseTimer)
    raiseTimer = null
  }
}

function prop(name, value) {
  try {
    const code = mpv.setPropertyString(ctx, name, String(value))
    if (code < 0) console.warn('[libmpv] prop', name, errorMessage(code))
  } catch {
    // ignore
  }
}

/** Após 1º frame: aumenta buffer (fluidez). */
function boostQualityAfterFirstFrame() {
  if (!ctx || qualityBoosted) return
  qualityBoosted = true
  prop('cache-secs', '45')
  prop('demuxer-readahead-secs', '20')
  prop('demuxer-max-bytes', '128MiB')
  prop('demuxer-max-back-bytes', '32MiB')
  prop('stream-buffer-size', '2MiB')
  prop('cache-pause', 'yes')
}

function tick() {
  if (!ctx || !running) return
  try {
    for (let i = 0; i < 24; i++) {
      const ev = mpv.waitEvent(ctx, 0)
      if (!ev) break
      const id = ev.event_id
      if (id === MPV_EVENT_NONE) break
      if (id === MPV_EVENT_SHUTDOWN) {
        emit({ type: 'stopped', value: -1 })
        break
      }
      if (id === MPV_EVENT_FILE_LOADED) {
        if (loadStartedAt) {
          const ms = Date.now() - loadStartedAt
          console.log(`[libmpv] file-loaded em ${ms}ms`)
          const snap = getPlaybackSnapshot()
          log.info('libmpv', 'FILE_LOADED', { ms, ...snap })
          if (snap?.dwidth > 0) log.info('libmpv', 'playback-snapshot', snap)
        }
        // Nunca fica pausado esperando buffer — toca assim que o demux libera
        try {
          mpv.setPropertyString(ctx, 'pause', 'no')
        } catch {
          // ignore
        }
        emit({ type: 'loaded' })
        if (pendingSeek > 1) {
          const at = pendingSeek
          pendingSeek = 0
          // Depois do demux — seek exact antes disso trava MP4 4K
          try {
            mpv.commandString(ctx, `seek ${at} absolute`)
          } catch {
            // ignore
          }
        }
      }
      if (id === MPV_EVENT_START_FILE || id === MPV_EVENT_PLAYBACK_RESTART) {
        try {
          mpv.setPropertyString(ctx, 'pause', 'no')
        } catch {
          // ignore
        }
        emit({ type: 'loaded' })
        emit({ type: 'playing' })
        if (mainWindow && !mainWindow.isDestroyed() && lastBounds) {
          try {
            overlay.show(mainWindow, lastBounds, { engine: 'libmpv', title: 'libmpv' })
          } catch {
            // ignore
          }
        }
        if (id === MPV_EVENT_PLAYBACK_RESTART) {
          if (loadStartedAt) {
            console.log(`[libmpv] playback-restart em ${Date.now() - loadStartedAt}ms`)
            loadStartedAt = 0
          }
          boostQualityAfterFirstFrame()
        }
      }
      if (id === MPV_EVENT_END_FILE) {
        // error != 0 no end-file = falha de carga (não EOF normal)
        if (ev.error && ev.error < 0) {
          emit({ type: 'error', value: errorMessage(ev.error) })
        } else {
          emit({ type: 'eof' })
        }
      }
    }

    const timeBuf = Buffer.alloc(8)
    if (mpv.getProperty(ctx, 'time-pos', MPV_FORMAT_DOUBLE, timeBuf) === 0) {
      const t = timeBuf.readDoubleLE(0)
      if (Number.isFinite(t) && t >= 0) emit({ type: 'time', value: t })
    }
    const durBuf = Buffer.alloc(8)
    if (mpv.getProperty(ctx, 'duration', MPV_FORMAT_DOUBLE, durBuf) === 0) {
      const d = durBuf.readDoubleLE(0)
      if (Number.isFinite(d) && d > 0) emit({ type: 'duration', value: d })
    }
    const pauseBuf = Buffer.alloc(8)
    if (mpv.getProperty(ctx, 'pause', MPV_FORMAT_FLAG, pauseBuf) === 0) {
      emit({ type: 'pause', value: pauseBuf.readInt32LE(0) !== 0 })
    }
    const cacheBuf = Buffer.alloc(8)
    if (mpv.getProperty(ctx, 'cache-buffering-state', MPV_FORMAT_INT64, cacheBuf) === 0) {
      const n = Number(cacheBuf.readBigInt64LE(0))
      if (Number.isFinite(n)) emit({ type: 'buffer', value: Math.max(0, Math.min(100, Math.round(n))) })
    }
  } catch {
    // ignore
  }
}

function startTimers() {
  if (pollTimer) return
  pollTimer = setInterval(tick, 160)
  raiseTimer = setInterval(() => {
    if (running && hostHwnd && lastBounds) placeHost(lastBounds)
  }, 700)
}

function opt(name, value) {
  const code = mpv.setOptionString(ctx, name, String(value))
  if (code < 0) console.warn('[libmpv] option', name, errorMessage(code))
}

/** Start agressivo: sem pause-inicial; buffer sobe depois do 1º frame. */
function applyFastStartOptions(hwnd) {
  opt('wid', hwnd.toString())
  opt('hwdec', 'auto-safe')
  opt('vo', 'gpu')
  opt('gpu-api', 'd3d11')
  opt('gpu-context', 'd3d11')

  opt('osc', 'no')
  opt('osd-level', '0')
  opt('osd-bar', 'no')
  opt('osd-on-seek', 'no')
  opt('input-default-bindings', 'no')
  opt('input-vo-keyboard', 'no')
  opt('keep-open', 'yes')
  opt('idle', 'yes')
  opt('keepaspect', 'yes')
  opt('panscan', '0')
  opt('video-unscaled', 'no')

  // Sem cache-pause-initial. NÃO reduzir probesize — MP4 com moov no fim quebra e demora 30s+
  opt('cache', 'yes')
  opt('cache-secs', '8')
  opt('cache-pause', 'no')
  opt('cache-pause-initial', 'no')
  opt('demuxer-max-bytes', '32MiB')
  opt('demuxer-max-back-bytes', '16MiB')
  opt('demuxer-readahead-secs', '2')

  opt('network-timeout', '20')
  opt('stream-buffer-size', '2MiB')
  opt('user-agent', 'VLC/3.0.21 LibVLC/3.0.21')
  opt('tls-verify', 'no')

  opt('sub-auto', 'fuzzy')
  opt('sid', 'auto')
  opt('alang', 'por,pt,pt-BR,eng,en')
  opt('slang', 'por,pt,pt-BR,eng,en')
}

function ensureWarmContext(win) {
  if (!loadApis()) throw new Error('libmpv-2.dll não encontrada')
  if (ctx && appliedConfigRev !== LIBMPV_CONFIG_REV) {
    hardDestroy()
  }
  const parent = windowHwnd(win)
  if (!parent) throw new Error('HWND da janela Electron inválido')
  ensureHost(parent)
  if (!lastBounds) placeHost({ x: 0, y: 0, width: 64, height: 64 })
  hideHost()

  if (ctx) return

  ctx = mpv.create()
  if (!ctx) throw new Error('mpv_create falhou')

  applyFastStartOptions(hostHwnd)

  const initCode = mpv.initialize(ctx)
  if (initCode < 0) {
    try {
      mpv.destroy(ctx)
    } catch {
      // ignore
    }
    ctx = null
    throw new Error(`mpv_initialize: ${errorMessage(initCode)}`)
  }

  mpv.observeProperty(ctx, 1n, 'time-pos', MPV_FORMAT_DOUBLE)
  mpv.observeProperty(ctx, 2n, 'duration', MPV_FORMAT_DOUBLE)
  mpv.observeProperty(ctx, 3n, 'pause', MPV_FORMAT_FLAG)
  appliedConfigRev = LIBMPV_CONFIG_REV
  startTimers()
  console.log('[libmpv] contexto aquecido (play imediato, rev', LIBMPV_CONFIG_REV, ')')
}

function hardDestroy() {
  cancelSoftStop()
  running = false
  clearTimers()
  playUrl = ''
  qualityBoosted = false
  loadStartedAt = 0
  appliedConfigRev = 0
  if (ctx) {
    try {
      mpv.destroy(ctx)
    } catch {
      // ignore
    }
    ctx = null
  }
  destroyHost()
}

/**
 * Soft stop: para o arquivo mas mantém DLL+ctx+HWND aquecidos.
 * Por padrão atrasa ~120ms — remount do React (mesmo URL) cancela e não mata o demux.
 */
/** @type {ReturnType<typeof setTimeout> | null} */
let softStopTimer = null

function cancelSoftStop() {
  if (softStopTimer) {
    clearTimeout(softStopTimer)
    softStopTimer = null
  }
}

function stopNow() {
  running = false
  playUrl = ''
  qualityBoosted = false
  loadStartedAt = 0
  if (ctx) {
    try {
      mpv.commandString(ctx, 'stop')
    } catch {
      // ignore
    }
  }
  hideHost()
  return { ok: true }
}

/**
 * @param {{ immediate?: boolean } | boolean} [opts]
 */
function stop(opts) {
  const immediate = opts === true || (opts && typeof opts === 'object' && opts.immediate)
  cancelSoftStop()
  if (immediate) return stopNow()
  softStopTimer = setTimeout(() => {
    softStopTimer = null
    stopNow()
  }, 120)
  return { ok: true, deferred: true }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} url
 * @param {number} [startTime]
 * @param {{ x:number,y:number,width:number,height:number } | null} [bounds]
 */
function start(win, url, startTime = 0, bounds = null) {
  if (!loadApis()) return { ok: false, error: 'libmpv-2.dll não encontrada (vendor/players/libmpv)' }
  if (!win || win.isDestroyed()) return { ok: false, error: 'Janela principal indisponível' }
  if (typeof url !== 'string' || !isPlayableUrl(url)) return { ok: false, error: 'URL inválida' }

  cancelSoftStop()
  mainWindow = win
  running = true
  qualityBoosted = false

  try {
    ensureWarmContext(win)
    placeHost(bounds || lastBounds || { x: 0, y: 0, width: 960, height: 540 })

    // Referrer atualizado a cada URL (ctx reutilizado)
    try {
      const origin = new URL(url).origin
      if (origin && !/127\.0\.0\.1/i.test(url)) prop('referrer', `${origin}/`)
    } catch {
      // ignore
    }

    // Buffer inicial moderado; boost sobe depois do 1º frame
    prop('cache-secs', '8')
    prop('demuxer-readahead-secs', '2')
    prop('demuxer-max-bytes', '32MiB')
    prop('cache-pause-initial', 'no')
    prop('cache-pause', 'no')
    prop('pause', 'no')

    // Remount / stop adiado: não relança o mesmo URL no meio do demux
    if (playUrl === url && loadStartedAt && Date.now() - loadStartedAt < 60_000) {
      pendingSeek =
        typeof startTime === 'number' && startTime > 1 && Number.isFinite(startTime) ? Math.floor(startTime) : pendingSeek
      console.log('[libmpv] loadfile ignorado (mesmo URL em curso)')
      return { ok: true, engine: 'libmpv', reused: true, deduped: true }
    }

    playUrl = url
    pendingSeek =
      typeof startTime === 'number' && startTime > 1 && Number.isFinite(startTime) ? Math.floor(startTime) : 0
    const safe = url.replace(/\\/g, '/').replace(/"/g, '\\"')
    loadStartedAt = Date.now()
    console.log('[libmpv] loadfile...')
    const loadCode = mpv.commandString(ctx, `loadfile "${safe}" replace`)
    if (loadCode < 0) throw new Error(`loadfile: ${errorMessage(loadCode)}`)

    startTimers()
    emit({ type: 'loaded' })
    return { ok: true, engine: 'libmpv', reused: true }
  } catch (error) {
    hardDestroy()
    return { ok: false, error: error instanceof Error ? error.message : 'Falha ao iniciar libmpv' }
  }
}

function setBounds(rect) {
  if (!rect || !(rect.width >= 32) || !(rect.height >= 32)) return { ok: false }
  const next = {
    x: Math.max(0, Math.round(Number(rect.x) || 0)),
    y: Math.max(0, Math.round(Number(rect.y) || 0)),
    width: Math.max(64, Math.round(Number(rect.width) || 0)),
    height: Math.max(64, Math.round(Number(rect.height) || 0)),
  }
  lastBounds = next
  // Sempre aplica no HWND (mesmo antes do play / após soft-stop) — evita borda preta
  if (hostHwnd) {
    if (running) placeHost(next)
    else {
      // Guarda bounds; não mostra host parado em cima da UI
      const s = scaleFactor()
      user32.SetWindowPos(
        Number(hostHwnd),
        0,
        Math.round(next.x * s),
        Math.round(next.y * s),
        Math.max(64, Math.round(next.width * s)),
        Math.max(64, Math.round(next.height * s)),
        SWP_NOACTIVATE,
      )
    }
  }
  return { ok: true }
}

function command(op, value) {
  if (!ctx) return { ok: false }
  try {
    if (op === 'toggle' || op === 'toggle-pause') mpv.commandString(ctx, 'cycle pause')
    else if (op === 'pause') mpv.setPropertyString(ctx, 'pause', 'yes')
    else if (op === 'play') mpv.setPropertyString(ctx, 'pause', 'no')
    else if (op === 'stop') mpv.commandString(ctx, 'stop')
    else if (op === 'seek' && typeof value === 'number') mpv.commandString(ctx, `seek ${value} absolute`)
    else if (op === 'skip' && typeof value === 'number') mpv.commandString(ctx, `seek ${value} relative`)
    else if (op === 'volume' && typeof value === 'number') {
      mpv.setPropertyString(ctx, 'volume', String(Math.round(Math.max(0, Math.min(100, value * 100)))))
    } else if (op === 'reload') {
      if (!playUrl) return { ok: false }
      const safe = playUrl.replace(/"/g, '\\"')
      qualityBoosted = false
      prop('cache-secs', '3')
      prop('demuxer-readahead-secs', '2')
      mpv.commandString(ctx, `loadfile "${safe}" replace`)
      if (typeof value === 'number' && value > 1) mpv.commandString(ctx, `seek ${Math.floor(value)} absolute`)
    } else if (typeof op === 'string' && op.trim()) {
      mpv.commandString(ctx, op)
    } else {
      return { ok: false }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'command failed' }
  }
}

function setMainWindow(win) {
  mainWindow = win
}

function getPlaybackSnapshot() {
  if (!ctx || !mpv) return null
  try {
    const wBuf = Buffer.alloc(8)
    const hBuf = Buffer.alloc(8)
    const pauseBuf = Buffer.alloc(8)
    const timeBuf = Buffer.alloc(8)
    mpv.getProperty(ctx, 'dwidth', MPV_FORMAT_INT64, wBuf)
    mpv.getProperty(ctx, 'dheight', MPV_FORMAT_INT64, hBuf)
    mpv.getProperty(ctx, 'pause', MPV_FORMAT_FLAG, pauseBuf)
    mpv.getProperty(ctx, 'time-pos', MPV_FORMAT_DOUBLE, timeBuf)
    return {
      dwidth: Number(wBuf.readBigInt64LE(0)),
      dheight: Number(hBuf.readBigInt64LE(0)),
      paused: pauseBuf.readInt32LE(0) !== 0,
      timePos: timeBuf.readDoubleLE(0),
    }
  } catch {
    return null
  }
}

module.exports = {
  isAvailable,
  resolveDll,
  preload,
  setMainWindow,
  start,
  stop,
  shutdown: hardDestroy,
  setBounds,
  command,
  isPreloaded: () => dllPreloaded,
  getPlaybackSnapshot,
}
