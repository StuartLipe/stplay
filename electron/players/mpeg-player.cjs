/**
 * MPEG — mpv embutido, cópia 1:1 do que o IPTV Smarters Pro faz pra abrir.
 *
 * O Smarters (player.js no app.asar dele) usa wcjs-player = libVLC embutido e
 * abre assim — nada mais:
 *   1. player.addPlaylist({ title, url: LiveVideoLink }) — URL CRUA, direta,
 *      sem preflight de manifesto, sem normalizer, sem resolve de redirect,
 *      sem remux, sem proxy. autoplay: true.
 *   2. onState error/ended → "Playback error, reconnects in 5s (x/5)" e tenta
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

/** Igual Smarters: 5 tentativas com 5s entre elas, no MESMO link. */
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
/** Tentativa atual (0 = primeira). Smarters conta 1/5..5/5. */
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

function showVideo(bounds) {
  if (!surfaceActive || !mpvHwnd || !winApi || !bounds || bounds.width < 16) return
  if (!ensureEmbedded(true)) return
  const s = scaleFactor()
  const x = Math.round(bounds.x * s)
  const y = Math.round(bounds.y * s)
  const w = Math.max(16, Math.round(bounds.width * s))
  const h = Math.max(16, Math.round(bounds.height * s))
  const placeKey = `${x},${y},${w},${h}`
  if (!videoHidden && lastPlacedKey === placeKey) {
    winApi.EnableWindow(mpvHwnd, false)
    try {
      overlay.syncBounds(bounds)
      overlay.bringToFront()
    } catch {
      // ignore
    }
    return
  }
  lastPlacedKey = placeKey
  winApi.EnableWindow(mpvHwnd, false)
  winApi.MoveWindow(mpvHwnd, x, y, w, h, true)
  winApi.SetWindowPos(mpvHwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
  winApi.ShowWindow(mpvHwnd, SW_SHOWNA)
  videoHidden = false
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
      overlay.sendUi({ action: 'playback-ready' })
    } catch {
      // ignore
    }
  }
  log.info('mpeg', 'first frame')
}

function scheduleRetry(reason) {
  // Igual Smarters: erro → tenta o MESMO link de novo em 5s, até 5x.
  if (retryCount >= MPEG_MAX_RETRIES) {
    emitFailed(reason || 'MPEG não abriu')
    killMpv()
    return
  }
  retryCount += 1
  const gen = loadGeneration
  log.warn('mpeg', 'reconnect', { try: `${retryCount}/${MPEG_MAX_RETRIES}`, reason })
  // Igual Smarters ("reconnects in 5s (x/5)"): o overlay mostra o contador.
  emit({ type: 'buffering', value: true, percent: 0, retry: retryCount, of: MPEG_MAX_RETRIES })
  clearRetry()
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (gen !== loadGeneration) return
    // Teto exato igual Smarters (5 no total): sem esta guarda o timer da
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
      emit({ type: 'timeupdate', current: msg.data })
      if (waitingFirstFrame && fileLoaded) onFirstFrame()
    }
    if (msg.name === 'duration' && typeof msg.data === 'number' && msg.data > 0) {
      emit({ type: 'duration', value: msg.data })
    }
    if (msg.name === 'pause') emit({ type: msg.data ? 'paused' : 'playing' })
    if (msg.name === 'dwidth' && typeof msg.data === 'number' && msg.data > 0) {
      if (waitingFirstFrame) onFirstFrame()
    }
    if (msg.name === 'cache-buffering-state' && typeof msg.data === 'number') {
      // Igual Smarters (onBuffering percent 0→100): o overlay mostra o número
      // subindo. Durante o boot mantém o véu até 100; fora dele só sinaliza.
      const pct = Math.max(0, Math.min(100, Math.round(msg.data)))
      if (waitingFirstFrame) {
        emit({ type: 'buffering', value: pct < 100, percent: pct })
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
    // EOF de verdade (VOD acabou) não é erro — igual Smarters (state ended).
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
    try {
      ipcSocket.write(JSON.stringify({ command: ['get_property', name], request_id: id }) + '\n')
    } catch {
      clearTimeout(timer)
      pendingRequests.delete(id)
      resolve(null)
    }
  })
}

/** Percentual 0→100 igual Smarters (e igual STUR): mede o cache a cada 400ms
 * enquanto o 1º frame não chega. Sem isso o número ficava parado. */
let bootPollTimer = null

function stopBootPoll() {
  if (bootPollTimer) {
    clearInterval(bootPollTimer)
    bootPollTimer = null
  }
}

function startBootPoll() {
  stopBootPoll()
  const target = mpegLive ? 2 : 5
  let shown = 0
  bootPollTimer = setInterval(async () => {
    if (!running || !waitingFirstFrame) {
      stopBootPoll()
      return
    }
    try {
      const secs = await getProperty('demuxer-cache-time')
      if (!running || !waitingFirstFrame) return
      let pct = 1
      if (typeof secs === 'number' && secs > 0) {
        pct = Math.max(1, Math.min(99, Math.round((secs / target) * 100)))
      }
      if (pct < shown) pct = shown
      shown = pct
      emit({ type: 'buffering', value: true, percent: pct })
    } catch {
      // próxima volta tenta de novo
    }
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

/** URL CRUA no mpv — sem preflight, sem normalizer, sem redirect. Igual Smarters. */
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

  // mpv direto, flags mínimas — igual o VLC do Smarters: autoplay, hwdec,
  // UA de VLC (painel libera igual), sem cache agressivo que atrasa o 1º frame.
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
  // Zap: limpa o frame velho na hora + véu de boot (igual Smarters — nada
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

async function command(op, value) {
  if (!ipcSocket || ipcSocket.destroyed) return { ok: false }
  try {
    if (op === 'pause') await sendIpc(['set_property', 'pause', true])
    else if (op === 'play') await sendIpc(['set_property', 'pause', false])
    else if (op === 'toggle' || op === 'toggle-pause') await sendIpc(['cycle', 'pause'])
    else if (op === 'seek' && typeof value === 'number') await sendIpc(['seek', value, 'absolute'])
    else if (op === 'volume' && typeof value === 'number') {
      await sendIpc(['set_property', 'volume', Math.round(Math.max(0, Math.min(100, value * 100)))])
    } else if (op === 'mute' && typeof value === 'boolean') {
      await sendIpc(['set_property', 'mute', value])
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
