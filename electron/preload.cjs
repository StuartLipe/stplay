const { contextBridge, ipcRenderer } = require('electron')

function readProxyBase() {
  try {
    const base = ipcRenderer.sendSync('sturplay:get-proxy-base')
    if (typeof base === 'string' && base.startsWith('http://127.0.0.1:')) return base
  } catch {
    // ignore
  }
  return 'sturplay://proxy'
}

function onChannel(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('sturplay', {
  proxyBase: readProxyBase(),
  coverBase: 'sturplay://cover',
  clearCoverCache: () => ipcRenderer.invoke('covers:clear'),
  player: {
    detect: () => ipcRenderer.invoke('player:detect'),
    open: (payload) => ipcRenderer.invoke('player:open', payload),
    start: (payload) => ipcRenderer.invoke('player:start', payload),
    hide: () => ipcRenderer.invoke('player:hide'),
    hideSync: () => ipcRenderer.sendSync('player:hide-sync'),
    restoreShell: () => ipcRenderer.sendSync('player:restore-shell'),
    stop: () => ipcRenderer.invoke('player:stop'),
    command: (op, value) => ipcRenderer.invoke('player:command', op, value),
    setBounds: (rect) => ipcRenderer.invoke('player:set-bounds', rect),
    syncOverlay: (rect) => ipcRenderer.invoke('overlay:sync-bounds', rect),
    setOverlayMeta: (meta) => ipcRenderer.invoke('overlay:set-meta', meta),
    setOverlayListOpen: (open) => ipcRenderer.invoke('overlay:set-list-open', open),
    setOverlayIgnoreMouse: (ignore) => ipcRenderer.invoke('overlay:set-ignore-mouse', ignore),
    sendOverlayAction: (action) => ipcRenderer.invoke('overlay:action', action),
    sendOverlayUi: (payload) => ipcRenderer.invoke('overlay:ui', payload),
    uiFullscreen: () => ipcRenderer.invoke('overlay:ui-fullscreen'),
    onUiFullscreen: (callback) => onChannel('player:ui-fullscreen', callback),
    onUiKey: (callback) => onChannel('player:ui-key', callback),
    onEvent: (callback) => onChannel('player:event', callback),
    onOverlayMeta: (callback) => onChannel('player:overlay-meta', callback),
    onOverlayAction: (callback) => onChannel('player:overlay-action', callback),
    onOverlayUi: (callback) => onChannel('player:overlay-ui', callback),
    /**
     * A JANELA mudou de posicao (arrastada, ou trocou de monitor).
     *
     * O renderer nao tem como descobrir isso sozinho: o rect do elemento e
     * medido em coordenadas de janela, entao `x/y/w/h` ficam identicos antes e
     * depois da mudanca, e o `ResizeObserver` tambem nao dispara porque o
     * elemento nao mudou de tamanho. Quem sabe do evento e o main — e o unico
     * que enxerga o `move` da janela.
     *
     * Medido: arrastar a janela para o segundo monitor deixava o video cobrindo
     * a janela inteira, porque o main continuava com o retangulo da tela
     * anterior.
     */
    onWindowMoved: (callback) => onChannel('player:window-moved', callback),
  },
  window: {
    setFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChanged: (callback) => onChannel('window:fullscreen-changed', callback),
  },
  nativePlayer: {
    open: (url, startTime, preferred) => ipcRenderer.invoke('native-player:open', url, startTime, preferred),
    detect: () => ipcRenderer.invoke('player:detect'),
    stop: () => ipcRenderer.invoke('player:stop'),
    stopExternal: () => ipcRenderer.invoke('native-player:stop-external'),
    focus: () => ipcRenderer.invoke('native-player:focus'),
    setBounds: (rect) => ipcRenderer.invoke('player:set-bounds', rect),
    command: (op, value) => ipcRenderer.invoke('player:command', op, value),
    onEvent: (callback) => onChannel('player:event', callback),
  },
  openDownloadsFolder: (folder) => ipcRenderer.invoke('downloads:open-folder', folder),
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: (manual) => ipcRenderer.invoke('updater:check', { manual: Boolean(manual) }),
    install: () => ipcRenderer.invoke('updater:install'),
    openReleases: () => ipcRenderer.invoke('updater:open-releases'),
    onEvent: (callback) => onChannel('updater:event', callback),
  },
  dev: {
    reportInternalTest: (payload) => ipcRenderer.invoke('dev:report-internal-test', payload),
    internalDebug: (payload) => ipcRenderer.invoke('internal-debug', payload),
    ffmpegWrap: (url, startSec, fresh) => ipcRenderer.invoke('ffmpeg:wrap', url, startSec, fresh),
  },
  downloads: {
    getFolder: () => ipcRenderer.invoke('downloads:get-folder'),
    pickFolder: () => ipcRenderer.invoke('downloads:pick-folder'),
    setFolder: (folder) => ipcRenderer.invoke('downloads:set-folder', folder),
    openFolder: (folder) => ipcRenderer.invoke('downloads:open-folder', folder),
    reveal: (filePath) => ipcRenderer.invoke('downloads:reveal', filePath),
    start: (payload) => ipcRenderer.invoke('downloads:start', payload),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    onProgress: (callback) => onChannel('downloads:progress', callback),
  },
})
