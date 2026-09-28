/**
 * mpv.exe embutido — reescrito do zero (modelo IPTV Player One).
 * Spawn offscreen → adopt HWND via koffi → IPC JSON.
 */
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const koffi = require('koffi')
const { screen } = require('electron')
const { findMpv } = require('../find-player.cjs')
const hwndHelper = require('./hwnd-helper.cjs')
const log = require('./player-log.cjs')
const overlay = require('./overlay-window.cjs')
const { isPlayableUrl } = require('./play-url.cjs')

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
let waitingFirstFrame = false
/** @type {number | null} */
let firstFrameBase = null
/** @type {ReturnType<typeof setInterval> | null} */
let raiseTimer = null

function isAvailable() {
  return Boolean(findMpv() && winApi)
}

function emit(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('player:event', payload)
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
      log.info('mpv-exe', 'adopted', { hwnd, pid, parent, attempt })
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
  if (waitingFirstFrame) return
  showVideo(bounds)
}

function killMpv() {
  running = false
  waitingFirstFrame = false
  firstFrameBase = null
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
  hideVideo()
  mpvHwnd = 0
  if (pid) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
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
        if (running) emit({ type: 'failed', reason: 'mpv IPC disconnected' })
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
  emit({ type: 'playing' })
  if (lastBounds) showVideo(lastBounds)
  if (mainWindow && !mainWindow.isDestroyed() && lastBounds) {
    try {
      overlay.show(mainWindow, lastBounds, { engine: 'mpv', title: 'mpv' })
    } catch {
      // ignore
    }
  }
  log.info('mpv-exe', 'first frame')
}

function handleIpcMessage(msg) {
  if (msg.event === 'property-change') {
    if (msg.name === 'time-pos' && typeof msg.data === 'number') {
      emit({ type: 'timeupdate', current: msg.data })
      if (waitingFirstFrame) {
        if (firstFrameBase === null) firstFrameBase = msg.data
        else if (msg.data > firstFrameBase + 0.3) onFirstFrame()
      }
    }
    if (msg.name === 'duration' && typeof msg.data === 'number') {
      emit({ type: 'duration', value: msg.data })
    }
    if (msg.name === 'pause') emit({ type: msg.data ? 'paused' : 'playing' })
    if (msg.name === 'dwidth' && typeof msg.data === 'number' && msg.data > 0) {
      if (waitingFirstFrame) onFirstFrame()
      else emit({ type: 'playing' })
    }
    if (msg.name === 'cache-buffering-state' && typeof msg.data === 'number') {
      emit({ type: 'buffering', value: msg.data > 0 && msg.data < 100 })
    }
  }
  if (msg.event === 'end-file') {
    if (msg.reason === 'eof') emit({ type: 'ended' })
    else emit({ type: 'failed', reason: `mpv end-file ${msg.reason}` })
  }
}

function sendIpc(command) {
  return new Promise((resolve) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      resolve(false)
      return
    }
    const id = ++requestId
    ipcSocket.write(JSON.stringify({ command, request_id: id }) + '\n', () => resolve(true))
  })
}

async function observeProperties() {
  const props = ['time-pos', 'duration', 'pause', 'dwidth', 'cache-buffering-state']
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

  killMpv()
  mainWindow = win
  running = true
  lastBounds = bounds
  waitingFirstFrame = true
  firstFrameBase = null

  parentHwnd = windowHwnd(win)
  if (!parentHwnd) return { ok: false, error: 'HWND pai inválido' }

  hwndHelper.prepareParent(parentHwnd)

  const mpvPath = findMpv()
  pipePath = `\\\\.\\pipe\\stplay-mpv-${process.pid}-${++pipeCounter}`
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
    '--user-agent=VLC/3.0.21 LibVLC/3.0.21',
    '--network-timeout=30',
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
  mpvProc.on('exit', () => {
    if (running) emit({ type: 'failed', reason: 'mpv.exe encerrou' })
    killMpv()
  })

  const [ipcOk, adopted] = await Promise.all([connectIpc(), adoptMpv(pid, parentHwnd)])
  if (!ipcOk || !adopted) {
    killMpv()
    log.warn('mpv-exe', 'start failed', { ipcOk, adopted, pid })
    return {
      ok: false,
      error: !ipcOk ? 'Falha ao conectar mpv.exe (IPC)' : 'Falha ao adotar janela mpv',
    }
  }

  await observeProperties()
  emit({ type: 'ready' })

  raiseTimer = setInterval(() => {
    if (!running || waitingFirstFrame || !mpvHwnd || !lastBounds) return
    showVideo(lastBounds)
  }, 600)

  const safe = url.replace(/\\/g, '/').replace(/"/g, '\\"')
  const startSec = typeof startTime === 'number' && startTime > 1 ? Math.floor(startTime) : 0
  if (startSec > 0) await sendIpc(['set_property', 'start', String(startSec)])
  await sendIpc(['loadfile', safe, 'replace'])

  log.info('mpv-exe', 'started', { pid, hwnd: mpvHwnd, url: url.slice(0, 80) })
  return { ok: true, engine: 'mpv' }
}

function stop() {
  killMpv()
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
  return { ok: true }
}

module.exports = {
  isAvailable,
  setMainWindow,
  start,
  stop,
  command,
  setBounds,
}
