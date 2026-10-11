/**
 * mpv One — motor separado.
 * Não altera mpv-exe-player.cjs nem o player interno.
 */
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const { forceKillProc } = require('./mpv-kill.cjs')
const koffi = require('koffi')
const { screen } = require('electron')
const { findMpv } = require('../find-player.cjs')
const { localPlayUrl, resolveRedirectUrl } = require('../stream-proxy.cjs')
const hwndHelper = require('./hwnd-helper.cjs')
const log = require('./player-log.cjs')
const { isPlayableUrl } = require('./play-url.cjs')
const overlay = require('./overlay-window.cjs')

const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const SW_HIDE = 0
const SW_SHOWNA = 8
const HWND_TOP = 0
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040

const winApi =
  process.platform === 'win32'
    ? (() => {
        const user32 = koffi.load('user32.dll')
        return {
          FindWindowExW: user32.func('intptr __stdcall FindWindowExW(intptr, intptr, str16, str16)'),
          GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr, _Out_ uint32*)'),
          SetParent: user32.func('intptr __stdcall SetParent(intptr, intptr)'),
          SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(intptr, int, intptr)'),
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
let requestId = 0
let ipcBuf = ''
let running = false
let killing = false
let waitingFirstFrame = false
let fileLoaded = false
/** @type {number | null} */
let firstFrameBase = null
/** @type {ReturnType<typeof setInterval> | null} */
let raiseTimer = null
const CACHE_PAUSE_WAIT = 8

/** @type {Map<number, (msg: { data?: unknown }) => void>} */
const pendingRequests = new Map()

function isAvailable() {
  return Boolean(findMpv('playerone') && winApi)
}

function emit(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('player:event', payload)
  try {
    overlay.sendEvent(payload)
  } catch {
    // ignore
  }
}

let cachePercent = 0
/** @type {ReturnType<typeof setInterval> | null} */
let bufferPollTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let durationPollTimer = null
/** @type {ReturnType<typeof setTimeout> | null} */
let loadWatchdog = null
let loadStartedAt = 0
let knownDuration = 0

/** @type {string | null} */
let sourceUrl = null

async function loadStream(url, viaProxy = false) {
  let playUrl = url
  if (viaProxy) {
    playUrl = await localPlayUrl(url)
  } else {
    try {
      const resolved = await resolveRedirectUrl(url)
      if (resolved === null) return null
      if (resolved) playUrl = resolved
    } catch {
      playUrl = url
    }
  }
  await sendIpc(['stop'])
  const res = await sendIpc(['loadfile', playUrl, 'replace'])
  if (!res.ok) {
    log.warn('mpv-one', 'loadfile failed', { viaProxy, error: res.error, url: playUrl.slice(0, 120) })
    return null
  }
  log.info('mpv-one', 'loadfile ok', { viaProxy, url: playUrl.slice(0, 120) })
  return playUrl
}

function clearLoadWatchdog() {
  if (loadWatchdog) {
    clearTimeout(loadWatchdog)
    loadWatchdog = null
  }
}

function armLoadWatchdog() {
  clearLoadWatchdog()
  const waitMs = fileLoaded ? 25_000 : 18_000
  loadWatchdog = setTimeout(async () => {
    loadWatchdog = null
    if (!running) return

    if (!fileLoaded) {
      log.warn('mpv-one', 'no file-loaded before timeout', { sourceUrl })
      emit({ type: 'failed', reason: 'Stream não iniciou — verifique conexão ou URL' })
      killMpv()
      return
    }

    if (!waitingFirstFrame) return

    const [cacheTime, dur] = await Promise.all([
      getProperty('demuxer-cache-time'),
      getProperty('duration'),
    ])
    const progressing =
      (typeof cacheTime === 'number' && cacheTime > 0.4) ||
      (typeof dur === 'number' && dur > 0) ||
      cachePercent > 2
    if (progressing) {
      armLoadWatchdog()
      return
    }
    log.warn('mpv-one', 'buffer watchdog timeout', { cacheTime, dur, cachePercent })
    emit({ type: 'failed', reason: 'Buffer não encheu — tente outro player' })
    killMpv()
  }, waitMs)
}

function percentFromCacheTime(secs) {
  if (secs <= 0) return 0
  return Math.max(1, Math.min(99, Math.round((secs / CACHE_PAUSE_WAIT) * 100)))
}

function reportBufferPercent(pct, opts = {}) {
  const { forceActive, absolute } = opts
  const rounded = Math.round(pct)
  const next = absolute ? rounded : Math.max(cachePercent, rounded)
  cachePercent = Math.max(0, Math.min(100, next))
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
  if (knownDuration > 0 && Math.abs(knownDuration - dur) < 0.5) return
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

function adoptMpvWindow(pid, parent) {
  const hwnd = findMpvHwnd(pid)
  if (!hwnd) return 0
  winApi.SetWindowLongPtrW(hwnd, GWL_STYLE, WS_CHILD | WS_VISIBLE)
  winApi.SetParent(hwnd, parent)
  winApi.ShowWindow(hwnd, SW_HIDE)
  return hwnd
}

async function adoptMpv(pid, parent) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const hwnd = adoptMpvWindow(pid, parent)
    if (hwnd > 0) {
      mpvHwnd = hwnd
      log.info('mpv-one', 'adopted', { hwnd, pid, parent, attempt })
      return true
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function hideVideo() {
  if (!mpvHwnd || !winApi) return
  winApi.ShowWindow(mpvHwnd, SW_HIDE)
  winApi.MoveWindow(mpvHwnd, -32000, -32000, 320, 180, false)
}

function showVideo(bounds) {
  if (!mpvHwnd || !winApi || !bounds || bounds.width < 16) return
  const s = scaleFactor()
  const x = Math.round(bounds.x * s)
  const y = Math.round(bounds.y * s)
  const w = Math.max(16, Math.round(bounds.width * s))
  const h = Math.max(16, Math.round(bounds.height * s))
  winApi.MoveWindow(mpvHwnd, x, y, w, h, true)
  winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
  winApi.ShowWindow(mpvHwnd, SW_SHOWNA)
  if (parentHwnd) void hwndHelper.childRaise(mpvHwnd)
}

function placeVideo(bounds) {
  if (!bounds || bounds.width < 16) return
  lastBounds = bounds
  if (waitingFirstFrame) {
    hideVideo()
    return
  }
  showVideo(bounds)
}

function killMpv(opts = {}) {
  if (killing) return
  killing = true
  running = false
  waitingFirstFrame = false
  fileLoaded = false
  sourceUrl = null
  firstFrameBase = null
  cachePercent = 0
  knownDuration = 0
  stopBufferPoll()
  stopDurationPoll()
  clearLoadWatchdog()
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
  forceKillProc(proc, { sync: opts.sync === true })
  killing = false
}

function waitMpvDead(proc, ms = 2500) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode != null) {
      resolve()
      return
    }
    const timer = setTimeout(() => resolve(), ms)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
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
        if (running) emit({ type: 'failed', reason: 'mpv One IPC disconnected' })
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

function presentPlayback() {
  if (!lastBounds || !mainWindow || mainWindow.isDestroyed()) return
  showVideo(lastBounds)
  try {
    overlay.show(mainWindow, lastBounds, { engine: 'mpv-one' })
    overlay.sendUi({ action: 'hide-loading' })
  } catch {
    // ignore
  }
}

function onFirstFrame() {
  if (!waitingFirstFrame) return
  waitingFirstFrame = false
  stopBufferPoll()
  clearLoadWatchdog()
  reportBufferPercent(100, { forceActive: false })
  presentPlayback()
  emit({ type: 'playing' })
  startDurationPoll()
  log.info('mpv-one', 'first frame')
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
      if (fileLoaded && waitingFirstFrame) {
        if (firstFrameBase === null) firstFrameBase = msg.data
        else if (msg.data > firstFrameBase + 0.3) onFirstFrame()
      }
    }
    if (msg.name === 'duration') {
      emitDuration(msg.data)
    }
    if (msg.name === 'pause') {
      if (waitingFirstFrame || !fileLoaded) {
        if (msg.data) emit({ type: 'paused' })
      } else {
        emit({ type: msg.data ? 'paused' : 'playing' })
      }
    }
    if (msg.name === 'cache-buffering-state' && typeof msg.data === 'number') {
      reportBufferPercent(Math.round(msg.data), {
        forceActive: waitingFirstFrame || !fileLoaded,
      })
    }
    if (msg.name === 'paused-for-cache' && typeof msg.data === 'boolean') {
      emit({ type: 'buffering', value: msg.data || waitingFirstFrame, percent: cachePercent })
    }
    if (msg.name === 'demuxer-cache-time' && typeof msg.data === 'number' && msg.data > 0) {
      armLoadWatchdog()
    }
    if (msg.name === 'dwidth' && typeof msg.data === 'number' && msg.data > 0) {
      if (fileLoaded && !waitingFirstFrame) emit({ type: 'playing' })
    }
  }
  if (msg.event === 'file-loaded') {
    fileLoaded = true
    waitingFirstFrame = true
    firstFrameBase = null
    hideVideo()
    startDurationPoll()
    emit({ type: 'preview' })
    armLoadWatchdog()
    log.info('mpv-one', 'file-loaded')
  }
  if (msg.event === 'end-file') {
    if (msg.reason === 'eof') emit({ type: 'ended' })
    else if (msg.reason === 'stop' || msg.reason === 'quit' || msg.reason === 'redirect') {
      log.info('mpv-one', 'end-file', { reason: msg.reason, sourceUrl })
    } else {
      log.warn('mpv-one', 'end-file', { reason: msg.reason, sourceUrl })
      emit({ type: 'failed', reason: `mpv One end-file ${msg.reason}` })
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

async function observeProperties() {
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
    await sendIpc(['observe_property', i + 1, props[i]])
  }
}

function setMainWindow(win) {
  mainWindow = win
}

async function start(win, url, startTime = 0, bounds = null) {
  if (!isAvailable()) return { ok: false, error: 'mpv.exe não encontrado' }
  if (!win || win.isDestroyed()) return { ok: false, error: 'Janela indisponível' }
  if (typeof url !== 'string' || !isPlayableUrl(url)) return { ok: false, error: 'URL inválida' }

  const prevProc = mpvProc
  killMpv()
  await waitMpvDead(prevProc)
  await new Promise((r) => setTimeout(r, 200))

  mainWindow = win
  running = true
  lastBounds = bounds
  waitingFirstFrame = false
  fileLoaded = false
  sourceUrl = url
  firstFrameBase = null
  cachePercent = 0
  reportBufferPercent(0, { forceActive: true })

  parentHwnd = windowHwnd(win)
  if (!parentHwnd) return { ok: false, error: 'HWND pai inválido' }

  hwndHelper.prepareParent(parentHwnd)

  const mpvPath = findMpv('playerone')
  pipePath = `\\\\.\\pipe\\stplay-mpv-one-${process.pid}-${++pipeCounter}`
  let origin = ''
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
    '--demuxer-max-bytes=512MiB',
    '--demuxer-readahead-secs=120',
    '--cache-pause-initial=yes',
    '--cache-pause-wait=8',
    '--user-agent=VLC/3.0.21 LibVLC/3.0.21',
    '--network-timeout=30',
    '--tls-verify=no',
    '--no-terminal',
  ]
  if (origin && !/127\.0\.0\.1/i.test(url)) args.push(`--referrer=${origin}/`)

  try {
    mpvProc = spawn(mpvPath, args, {
      cwd: path.dirname(mpvPath),
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch (error) {
    running = false
    return { ok: false, error: error instanceof Error ? error.message : 'spawn failed' }
  }

  const pid = mpvProc.pid || 0
  const thisProc = mpvProc
  mpvProc.on('exit', () => {
    if (mpvProc !== thisProc) return
    if (killing) return
    if (running) emit({ type: 'failed', reason: 'mpv One encerrou' })
    killMpv()
  })

  const [ipcOk, adopted] = await Promise.all([connectIpc(), adoptMpv(pid, parentHwnd)])
  if (!ipcOk || !adopted) {
    killMpv()
    log.warn('mpv-one', 'start failed', { ipcOk, adopted, pid })
    return {
      ok: false,
      error: !ipcOk ? 'Falha ao conectar mpv One (IPC)' : 'Falha ao adotar janela mpv',
    }
  }

  await observeProperties()
  emit({ type: 'ready' })
  startBufferPoll()

  raiseTimer = setInterval(() => {
    if (!running || waitingFirstFrame || !mpvHwnd || !lastBounds) return
    showVideo(lastBounds)
  }, 600)

  const startSec = typeof startTime === 'number' && startTime > 1 ? Math.floor(startTime) : 0
  if (startSec > 0) await sendIpc(['set_property', 'start', String(startSec)])

  let playUrl = await loadStream(url, false)
  let proxied = false
  if (!playUrl) {
    playUrl = await loadStream(url, true)
    proxied = Boolean(playUrl)
  }
  if (!playUrl) {
    killMpv()
    return { ok: false, error: 'Falha ao abrir stream no mpv One' }
  }

  armLoadWatchdog()

  log.info('mpv-one', 'started', { pid, hwnd: mpvHwnd, proxied, url: playUrl.slice(0, 120) })
  return { ok: true, engine: 'mpv-one' }
}

function stop(opts = {}) {
  killMpv(opts)
  return { ok: true }
}

async function command(op, value) {
  if (!ipcSocket || ipcSocket.destroyed) return { ok: false }
  try {
    if (op === 'pause') await sendIpc(['set_property', 'pause', true])
    else if (op === 'play') await sendIpc(['set_property', 'pause', false])
    else if (op === 'toggle' || op === 'toggle-pause') await sendIpc(['cycle', 'pause'])
    else if (op === 'seek' && typeof value === 'number') await sendIpc(['seek', value, 'absolute'])
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
  try {
    overlay.syncBounds(rect)
  } catch {
    // ignore
  }
  return { ok: true }
}

function refreshLayout() {
  if (!running || !mpvHwnd) return { ok: false }
  if (waitingFirstFrame || !lastBounds) {
    // Este módulo nunca teve `ensureEmbedded` — era cópia de stur-player.cjs que
    // sobreviveu ao refactor do HWND nativo. A chamada lançava ReferenceError,
    // o único caller (player-host.cjs bindFocusHooks.onLayout) engole em
    // try/catch vazio, e o efeito real era: maximizar a janela com o motor
    // mpv-one deixava o HWND do mpv solto, no tamanho antigo, com quadro preto.
    // Faz o mesmo que adoptMpv(): estilo filho, re-parent, esconde.
    try {
      winApi.SetWindowLongPtrW(mpvHwnd, GWL_STYLE, WS_CHILD | WS_VISIBLE)
      if (parentHwnd) winApi.SetParent(mpvHwnd, parentHwnd)
      winApi.ShowWindow(mpvHwnd, SW_HIDE)
    } catch (error) {
      log.warn('mpv-one', 're-embed no refreshLayout falhou', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return { ok: true }
  }
  showVideo(lastBounds)
  return { ok: true }
}

module.exports = {
  isAvailable,
  setMainWindow,
  start,
  stop,
  command,
  setBounds,
  refreshLayout,
}
