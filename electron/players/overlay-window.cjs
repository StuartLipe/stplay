const path = require('path')
const { pathToFileURL } = require('url')
const { BrowserWindow, app } = require('electron')
const { overlayShellRect } = require('./overlay-bounds.cjs')
const { hardenWebContents } = require('../harden-web-contents.cjs')
const { info: logInfo, warn: logWarn } = require('./player-log.cjs')

/** @type {BrowserWindow | null} */
let overlayWin = null
/** @type {import('electron').BrowserWindow | null} */
let parentWin = null
/** @type {{ x: number; y: number; width: number; height: number } | null} */
let contentRect = null
/** @type {Record<string, unknown> | null} */
let lastMeta = null
/** @type {{ x: number; y: number; width: number; height: number } | null} */
let lastRect = null
/** @type {Record<string, unknown> | null} */
let lastPlaybackEvent = null
let overlaySuspended = false
let listPanelOpen = false
let overlayReady = false
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null
let lastAppliedBoundsKey = ''
/** true = cliques passam pro vídeo/app; false = captura nos controles */
let ignoringMouse = true

function activeOverlayRect() {
  if (!lastRect) return null
  return overlayShellRect(lastRect, { listOpen: listPanelOpen })
}

function getLoadUrl() {
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (!app.isPackaged && devUrl) return `${devUrl}#player-overlay`
  return `${pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.html')).href}#player-overlay`
}

function contentToScreen(parent, rect) {
  if (!parent || parent.isDestroyed()) return rect
  const origin = parent.getContentBounds()
  return {
    x: Math.round(origin.x + rect.x),
    y: Math.round(origin.y + rect.y),
    width: Math.max(64, Math.round(rect.width)),
    height: Math.max(64, Math.round(rect.height)),
  }
}

function setIgnoreMouse(ignore) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  ignoringMouse = ignore === true
  try {
    if (ignoringMouse) overlayWin.setIgnoreMouseEvents(true, { forward: true })
    else overlayWin.setIgnoreMouseEvents(false)
  } catch {
    // ignore
  }
}

function ensureOverlay(parent) {
  parentWin = parent
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayReady = false
  overlayWin = new BrowserWindow({
    parent,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    thickFrame: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    show: false,
    width: 64,
    height: 64,
    x: -32000,
    y: -32000,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  void overlayWin.loadURL(getLoadUrl())
  // O overlay tem o MESMO preload privilegiado da janela principal. Sem este
  // guard, `target=_blank` ou `location.href` o levavam para a internet com a
  // ponte ainda anexada.
  hardenWebContents(overlayWin.webContents, { warn: logWarn, info: logInfo })
  overlayWin.webContents.on('did-finish-load', () => {
    overlayReady = true
    flushOverlayState()
  })
  overlayWin.on('closed', () => {
    overlayWin = null
    overlayReady = false
  })
  overlayWin.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !parentWin || parentWin.isDestroyed()) return
    if (input.key === 'Escape') {
      event.preventDefault()
      try {
        parentWin.webContents.send('player:ui-key', { key: 'Escape' })
      } catch {
        // ignore
      }
    }
  })
  return overlayWin
}

function flushOverlayState() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) return
  try {
    if (lastMeta) overlayWin.webContents.send('player:overlay-meta', lastMeta)
    if (lastPlaybackEvent) overlayWin.webContents.send('player:event', lastPlaybackEvent)
  } catch {
    // ignore
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushOverlayState()
  }, 50)
  setTimeout(() => flushOverlayState(), 250)
  setTimeout(() => flushOverlayState(), 600)
}

function applyOverlayLayout() {
  if (overlaySuspended) return
  if (!parentWin || parentWin.isDestroyed() || !overlayWin || overlayWin.isDestroyed()) return
  if (!lastRect) return
  const shell = activeOverlayRect()
  if (!shell) return
  const screen = contentToScreen(parentWin, shell)
  const key = `${screen.x},${screen.y},${screen.width},${screen.height},list=${listPanelOpen ? 1 : 0}`
  if (key === lastAppliedBoundsKey) return
  lastAppliedBoundsKey = key
  contentRect = shell
  overlayWin.setBounds(screen)
}

function relayoutToParent() {
  applyOverlayLayout()
}

function syncBounds(rect) {
  if (overlaySuspended) return
  if (!parentWin || parentWin.isDestroyed() || !overlayWin || overlayWin.isDestroyed()) return
  if (!rect || rect.width < 32 || rect.height < 32) return
  lastRect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
  applyOverlayLayout()
}

function setListPanelOpen(open) {
  listPanelOpen = open === true
  lastAppliedBoundsKey = ''
  applyOverlayLayout()
  setIgnoreMouse(false)
  return { ok: true }
}

function mergeMeta(partial = {}) {
  lastMeta = { ...(lastMeta || {}), ...partial }
  return lastMeta
}

function focusOverlay() {
  if (overlaySuspended || !overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return
  try {
    overlayWin.focus()
  } catch {
    // ignore
  }
}

function show(parent, rect, meta = {}) {
  overlaySuspended = false
  const win = ensureOverlay(parent)
  const merged = mergeMeta(meta)
  const safe = rect && rect.width >= 64 && rect.height >= 64 ? rect : null
  if (!safe) return { ok: false }
  lastRect = {
    x: Math.round(safe.x),
    y: Math.round(safe.y),
    width: Math.round(safe.width),
    height: Math.round(safe.height),
  }
  lastAppliedBoundsKey = ''
  applyOverlayLayout()
  try {
    win.webContents.send('player:overlay-meta', merged)
  } catch {
    // ignore
  }
  // Controles com fundo opaco recebem clique; resto transparente passa pro vídeo
  setIgnoreMouse(false)
  win.showInactive()
  try {
    win.moveTop()
  } catch {
    // ignore
  }
  bindMouseWake(parent)
  scheduleFlush()
  return { ok: true }
}

function reshow() {
  if (!parentWin || parentWin.isDestroyed() || !lastRect) return { ok: false }
  return show(parentWin, lastRect, lastMeta || {})
}

function canReshow() {
  return Boolean(parentWin && !parentWin.isDestroyed() && lastRect && !overlaySuspended)
}

function setMeta(meta = {}) {
  const merged = mergeMeta(meta)
  if (!overlayWin || overlayWin.isDestroyed()) return
  try {
    overlayWin.webContents.send('player:overlay-meta', merged)
  } catch {
    // ignore
  }
}

function sendEvent(payload) {
  if (payload && typeof payload === 'object' && payload.type) {
    const t = String(payload.type)
    if (
      t === 'playing' ||
      t === 'paused' ||
      t === 'ready' ||
      t === 'failed' ||
      t === 'preview' ||
      t === 'buffering'
    ) {
      lastPlaybackEvent = payload
    }
  }
  if (!overlayWin || overlayWin.isDestroyed()) return
  try {
    overlayWin.webContents.send('player:event', payload)
  } catch {
    // ignore
  }
}

function hide() {
  overlaySuspended = true
  listPanelOpen = false
  contentRect = null
  lastRect = null
  lastAppliedBoundsKey = ''
  lastPlaybackEvent = { type: 'ready' }
  if (overlayWin && !overlayWin.isDestroyed()) {
    setIgnoreMouse(true)
    try {
      overlayWin.hide()
    } catch {
      // ignore
    }
    try {
      overlayWin.setBounds({ x: -32000, y: -32000, width: 1, height: 1 })
    } catch {
      // ignore
    }
  }
  return { ok: true }
}

/** Mata overlay órfão (ex.: após fechar durante reprodução). */
function destroyIfIdle() {
  if (lastRect || !overlaySuspended) return { ok: true }
  if (!overlayWin || overlayWin.isDestroyed()) return { ok: true }
  try {
    overlayWin.destroy()
  } catch {
    // ignore
  }
  overlayWin = null
  overlayReady = false
  return { ok: true }
}

function resume() {
  overlaySuspended = false
  return { ok: true }
}

function destroy() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
  }
  overlayWin = null
  parentWin = null
  contentRect = null
  lastPlaybackEvent = null
  overlayReady = false
}

function bindParent(parent) {
  parentWin = parent
  // Overlay só na 1ª reprodução — criar aqui deixava janela filha transparente cobrindo a UI.
  const onMoveResize = () => {
    applyOverlayLayout()
  }
  parent.on('move', onMoveResize)
  parent.on('resize', onMoveResize)
  parent.on('focus', onMoveResize)
  parent.on('blur', onMoveResize)
  parent.on('enter-full-screen', () => {
    setTimeout(() => relayoutToParent(), 50)
    setTimeout(() => relayoutToParent(), 200)
  })
  parent.on('leave-full-screen', () => {
    setTimeout(() => onMoveResize(), 50)
    setTimeout(() => onMoveResize(), 200)
  })
}

function bringToFront() {
  if (overlaySuspended) {
    resume()
    return reshow()
  }
  if (!overlayWin || overlayWin.isDestroyed()) return { ok: false }
  if (!overlayWin.isVisible()) return reshow()
  try {
    overlayWin.moveTop()
  } catch {
    // ignore
  }
  return { ok: true }
}

function bindMouseWake(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return
  if (win.__stplayOverlayMouseWake) return
  win.__stplayOverlayMouseWake = true
  const wake = () => {
    if (overlaySuspended || !overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return
    try {
      overlayWin.moveTop()
    } catch {
      // ignore
    }
    sendUi({ action: 'show-controls' })
  }
  try {
    win.hookWindowMessage(0x0200, wake)
    win.hookWindowMessage(0x0201, wake)
    win.hookWindowMessage(0x0246, wake)
  } catch {
    // ignore
  }
}

function sendUi(payload = {}) {
  if (!overlayWin || overlayWin.isDestroyed()) return
  try {
    overlayWin.webContents.send('player:overlay-ui', payload)
  } catch {
    // ignore
  }
}

module.exports = {
  show,
  hide,
  resume,
  reshow,
  canReshow,
  bringToFront,
  focusOverlay,
  syncBounds,
  destroy,
  destroyIfIdle,
  bindParent,
  sendEvent,
  sendUi,
  setMeta,
  relayoutToParent,
  setListPanelOpen,
  setIgnoreMouse,
}
