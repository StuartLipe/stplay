const { app, BrowserWindow, Menu, protocol, net, session, shell, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const logWriter = require('./log-writer.cjs')
const crypto = require('crypto')
const { ipcMain } = require('electron')
const { hardenWebContents } = require('./harden-web-contents.cjs')
const { registerDownloadsIpc } = require('./downloads.cjs')
const updaterHost = require('./updater.cjs')
const { ensureStreamProxy, proxyBaseUrl } = require('./stream-proxy.cjs')
const ffmpegProxy = require('./stur-ffmpeg-proxy.cjs')
const playerHost = require('./players/player-host.cjs')
// setName ANTES de qualquer player-log: getPath('userData') materializa o caminho na
// 1ª chamada e fica em cache — sem isto, logs cem em %APPDATA%\Electron em dev.
app.setName('ST PLAY')
const plog = require('./players/player-log.cjs')
plog.info('app', 'main loaded', { pid: process.pid, dev: !app.isPackaged, t: Date.now() })
const {
  sanitizeHeaderValue,
  sanitizeHeadersObject,
  safeResponseHeaders,
  isByteStringError,
} = require('./latin1-headers.cjs')

process.on('uncaughtException', (error) => {
  if (isByteStringError(error)) {
    console.error('[stplay] ByteString header ignored:', error instanceof Error ? error.message : error)
    return
  }
  console.error('[stplay] uncaughtException:', error)
})

process.on('unhandledRejection', (reason) => {
  if (isByteStringError(reason)) {
    console.error('[stplay] ByteString rejection ignored:', reason instanceof Error ? reason.message : reason)
    return
  }
  console.error('[stplay] unhandledRejection:', reason)
})

let coverCacheDir = ''
const COVER_FETCH_MAX = 8
let coverFetchesActive = 0
const coverFetchWait = []

function acquireCoverFetch() {
  return new Promise((resolve) => {
    if (coverFetchesActive < COVER_FETCH_MAX) {
      coverFetchesActive += 1
      resolve()
      return
    }
    coverFetchWait.push(resolve)
  })
}

function releaseCoverFetch() {
  coverFetchesActive = Math.max(0, coverFetchesActive - 1)
  const next = coverFetchWait.shift()
  if (next) {
    coverFetchesActive += 1
    next()
  }
}

function coverFilePath(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex')
  let ext = '.img'
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i)
    if (match) ext = match[0].toLowerCase().replace('.jpeg', '.jpg')
  } catch {
    // keep .img
  }
  return path.join(coverCacheDir, `${hash}${ext}`)
}

function guessMime(filePath, fallback) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return fallback || 'image/jpeg'
}

async function handleCoverCache(request) {
  const incoming = new URL(request.url)
  const target = incoming.searchParams.get('url')
  if (!target || !isAllowedTarget(target)) {
    return new Response('invalid url', { status: 400 })
  }

  const file = coverFilePath(target)
  try {
    if (fs.existsSync(file)) {
      const data = await fs.promises.readFile(file)
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': guessMime(file),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
  } catch {
    // fall through to network
  }

  await acquireCoverFetch()
  try {
    // Another request may have written the file while we waited
    if (fs.existsSync(file)) {
      const data = await fs.promises.readFile(file)
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': guessMime(file),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    const dest = new URL(target)
    const response = await net.fetch(dest.href, {
      method: 'GET',
      headers: sanitizeHeadersObject({
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        Referer: `${dest.origin}/`,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      }),
      bypassCustomProtocolHandlers: true,
    })
    if (!response.ok) {
      return new Response(await response.arrayBuffer().catch(() => 'cover failed'), {
        status: response.status || 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    try {
      fs.mkdirSync(coverCacheDir, { recursive: true })
      await fs.promises.writeFile(file, buffer)
    } catch {
      // still return the image even if disk write fails
    }

    const rawType = response.headers.get('content-type') || guessMime(file)
    const contentType = sanitizeHeaderValue(rawType.split(';')[0].trim()) || guessMime(file)
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'cover failed', {
      status: 502,
    })
  } finally {
    releaseCoverFetch()
  }
}

async function handleSturplay(request) {
  // `return handleCoverCache(request)` dentro do try NÃO era protegido: sem
  // `await`, o catch não vê a rejeição, e ela escapava como rejeição do handler
  // de protocolo. Oito capas com falha de rede davam oito
  // `unhandledRejection: net::ERR_HTTP2_PROTOCOL_ERROR` no processo principal.
  try {
    const incoming = new URL(request.url)
    if (incoming.hostname === 'cover') {
      const res = await handleCoverCache(request)
      return res
    }
  } catch (error) {
    plog.warn('app', 'sturplay:cover falhou', {
      error: error instanceof Error ? error.message : String(error),
    })
    return new Response('cover failed', { status: 502 })
  }
  return handleProxy(request)
}

ipcMain.handle('native-player:open', async (_event, url, startTime, preferred) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'URL inválida' }
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return { ok: false, error: 'Janela indisponível' }
  await playerHost.stopAll()
  const engine = preferred === 'mpc' ? 'mpc' : 'vlc'
  return playerHost.startEngine?.(engine, url, startTime, null, win) || { ok: false, error: 'Host indisponível' }
})

registerDownloadsIpc()
playerHost.registerPlayerIpc()

// Debug do player interno: renderer manda sessão HLS (url anonimizada) pra arquivo.
// Arquivo: %APPDATA%\ST PLAY\internal-debug.log
ipcMain.handle('internal-debug', async (event, payload) => {
  try {
    const { app } = require('electron')
    const dir = app.getPath('userData')
    const line = JSON.stringify({ at: new Date().toISOString(), ...payload })
    // Antes: mkdirSync + appendFileSync por mensagem, no processo principal.
    logWriter.append(path.join(dir, 'internal-debug.log'), line)
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

// Remux local pro player interno: TS/HEVC/AC3 que o Chromium não abre sozinho.
// ffmpeg copia o vídeo e o renderer toca o fmp4 progressivo. Sem mpv no interno.
ipcMain.handle('ffmpeg:wrap', async (_event, remoteUrl, startSec, fresh) => {
  try {
    if (typeof remoteUrl !== 'string' || !/^https?:\/\//i.test(remoteUrl)) return { ok: false }
    const url = await ffmpegProxy.wrapUrl(remoteUrl, Math.max(0, Number(startSec) || 0), fresh === true)
    return { ok: true, url }
  } catch {
    return { ok: false }
  }
})

ipcMain.on('sturplay:get-proxy-base', (event) => {
  const base = proxyBaseUrl()
  event.returnValue = base || 'sturplay://proxy'
})

ipcMain.handle('covers:clear', async () => {
  try {
    if (coverCacheDir && fs.existsSync(coverCacheDir)) {
      await fs.promises.rm(coverCacheDir, { recursive: true, force: true })
    }
    if (coverCacheDir) fs.mkdirSync(coverCacheDir, { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'clear failed' }
  }
})

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('allow-insecure-localhost', 'true')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode')
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,CanvasOopRasterization')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sturplay',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
])

app.setAppUserModelId('com.stplay.app')

function isAllowedTarget(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

async function handleProxy(request) {
  const incoming = new URL(request.url)
  const target = incoming.searchParams.get('url')
  if (!target || !isAllowedTarget(target)) {
    return new Response('invalid url', { status: 400 })
  }

  const dest = new URL(target)
  const headers = sanitizeHeadersObject({
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
    Referer: `${dest.origin}/`,
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  })
  const range = request.headers.get('range')
  if (range) headers.Range = sanitizeHeaderValue(range)
  // Aceita Accept do cliente só para streams de mídia; API Xtream fica */*
  const accept = request.headers.get('accept')
  if (accept && !/player_api\.php|\/get\.php/i.test(dest.href)) {
    const safeAccept = sanitizeHeaderValue(accept)
    if (safeAccept) headers.Accept = safeAccept
  }

  try {
    const upstream = await net.fetch(dest.href, {
      method: 'GET',
      headers,
      bypassCustomProtocolHandlers: true,
    })
    // Não repassa Content-Disposition/filenames unicode do painel (ByteString crash).
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: safeResponseHeaders(upstream),
    })
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'proxy failed', {
      status: 502,
    })
  }
}

function resolveAppIcon() {
  const candidates = [
    path.join(__dirname, 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
  ]
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const image = nativeImage.createFromPath(candidate)
        if (!image.isEmpty()) return { path: candidate, image }
      }
    } catch {
      // try next
    }
  }
  return null
}

/** Mínimo da janela = celular em horizontal (referência iPhone 14 landscape). */
const MOBILE_MIN_WIDTH = 844
const MOBILE_MIN_HEIGHT = 390

function createWindow() {
  const appIcon = resolveAppIcon()
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const isTv = screenW >= 1800
  const win = new BrowserWindow({
    title: 'ST PLAY',
    width: Math.min(isTv ? 1600 : 1400, screenW),
    height: Math.min(isTv ? 900 : 860, screenH),
    minWidth: MOBILE_MIN_WIDTH,
    minHeight: MOBILE_MIN_HEIGHT,
    backgroundColor: '#07090f',
    autoHideMenuBar: true,
    show: false,
    icon: appIcon?.path,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      // Desligados em 1.0.5 sem necessidade: todo stream já passa pelo proxy em
      // 127.0.0.1, que devolve ACAO. Com webSecurity desligado a SOP cai, e o
      // renderer carrega dado de painel (hostil por natureza) mais URLs de
      // stream arbitrárias — o resto da janela já estava travado em node, mas
      // o SOP era o que segurava o resto.
      webSecurity: true,
      allowRunningInsecureContent: false,
      v8CacheOptions: 'code',
    },
  })

  if (appIcon?.image) win.setIcon(appIcon.image)

  updaterHost.setJanelaPrincipal(win)

  win.once('ready-to-show', () => {
    plog.info('app', 'window ready-to-show')
    playerHost.ensureShellVisible()
    win.show()
    /*
     * A checagem de atualizacao sai aqui, e nao no boot, por dois motivos.
     *
     * O primeiro e o app: o `main.cjs` ainda esta derrubar o proxy de stream e
     * o cache de capas quando a janela aparece, e uma consulta de rede extra
     * disputaria bandwidth com o catalogo que a pessoa esta esperando carregar.
     *
     * O segundo e o `autoUpdater.checkForUpdates()` em dev: em dev nao ha
     * `app-update.yml` dentro do asar, e a chamada rejeitaria. O `checar()`
     * ja devolve `{ reason: 'dev' }` sem tocar na rede nesse caso, entao o
     * timer e inofensivo — mas fica atrasado assim mesmo, porque em dev nao ha
     * o que checar.
     */
    setTimeout(() => {
      void updaterHost.checar({ manual: false })
    }, 8000)
    const devRendererTest = process.env.STPLAY_DEV_RENDERER_TEST === '1'
    const devOpen = process.env.STPLAY_DEV_OPEN
    const devTest = process.env.STPLAY_DEV_TEST === '1'
    const devValidate = process.env.STPLAY_DEV_VALIDATE === '1'
    if (devRendererTest) return
    if (devValidate && devOpen) {
      setTimeout(() => {
        const { runValidation } = require('./players/validate-mpv-modes.cjs')
        void runValidation(playerHost, win)
      }, 1500)
    } else if (devTest && devOpen) {
      setTimeout(() => {
        const { runPlayerTests } = require('./players/dev-player-test.cjs')
        void runPlayerTests(playerHost, win)
      }, 1500)
    } else if (devOpen) {
      const engine = process.env.STPLAY_DEV_ENGINE || 'auto'
      setTimeout(() => {
        void playerHost.openFile({ path: devOpen, engine }).then((result) => {
          console.log('[dev] STPLAY_DEV_OPEN', result)
        })
      }, 1200)
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (process.env.STPLAY_DEV_RENDERER_TEST === '1') {
    const { setupRendererTest } = require('./players/dev-renderer-test.cjs')
    void setupRendererTest(win)
  } else if (!app.isPackaged && devUrl) {
    plog.info('app', 'loading dev url', { devUrl })
    void win.loadURL(devUrl)
  } else {
    plog.info('app', 'loading dist index.html')
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  // GANCHO DE TESTE, so de dev e so com variavel de ambiente.
  //
  // Existe porque verificar o motor exige ALGUEM abrir um canal, e um clique
  // humano nao e reprodutivel de madrugada. Ele dispara o preload de dentro do
  // renderer — `window.sturplay.player.start(...)` — que e exatamente o que um
  // clique dispara: mesmo preload, mesmo IPC, mesmo handler, mesmo motor. Sem a
  // variavel, nada acontece e o app se comporta igual.
  const autotestUrl = !app.isPackaged ? process.env.STPLAY_AUTOTEST_URL : null
  win.webContents.on('did-finish-load', () => {
    plog.info('app', 'renderer did-finish-load')
    if (!autotestUrl) return
    setTimeout(() => {
      const b = win.getContentBounds()
      const payload = {
        engine: 'stur',
        url: autotestUrl,
        startTime: 0,
        bounds: { x: 0, y: 0, width: b.width, height: b.height },
        live: true,
      }
      plog.info('app', 'autotest disparando player:start', { url: autotestUrl.slice(0, 120) })
      const script = `window.sturplay
        && window.sturplay.player
        && window.sturplay.player.start(${JSON.stringify(payload)})
        .then(function (r) {
          return window.sturplay.dev.internalDebug({ autotest: 'start', result: r })
        })
        .catch(function (e) {
          return window.sturplay.dev.internalDebug({ autotest: 'erro', error: String(e) })
        })`
      void win.webContents.executeJavaScript(script).then(
        (r) => plog.info('app', 'autotest player:start', r),
        (e) => plog.warn('app', 'autotest executeJavaScript falhou', { error: String(e) }),
      )

      // Teste de F11, sem humano. `sendInputEvent` entra pelo mesmo pipeline de
      // teclado que uma tecla de verdade, entao exercita o handler de verdade —
      // inclusive o closure velho que era o bug.
      setTimeout(() => {
        const apertar = (acao) => {
          for (const tipo of ['keyDown', 'keyUp']) {
            win.webContents.sendInputEvent({ type: tipo, keyCode: 'F11', code: 'F11', windowsVirtualKeyCode: 122 })
          }
          void acao
        }
        const estado = (rotulo) => {
          plog.info('app', 'autotest F11', { momento: rotulo, janelaFullscreen: win.isFullScreen() })
        }
        estado('antes do 1o F11')
        apertar()
        setTimeout(() => {
          estado('depois do 1o F11 (esperando entrar)')
          apertar()
          setTimeout(() => estado('depois do 2o F11 (esperando sair)'), 2500)
        }, 2500)
      }, 20000)
    }, 8000)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    plog.warn('app', 'renderer did-fail-load', { code, desc, url: String(url).slice(0, 120) }),
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    plog.warn('app', 'render-process-gone', { reason: details?.reason, exitCode: details?.exitCode }),
  )
  // Navegacao e window-open sao por webContents, entao a janela de overlay
  // precisa do mesmo guard — ela tem o mesmo preload privilegiado.
  hardenWebContents(win.webContents, plog)
  win.on('closed', () => plog.info('app', 'window closed'))

  playerHost.setMainWindow(win)

  // Erro do renderer vai para o mesmo log. Sem isto, uma exceção de render
  // aparecia como "o app bugou" e não havia como saber o que era — o processo
  // principal registra zero coisas quando o problema é no React.
  const stamp = (level, kind, detail) => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        scope: 'renderer',
        message: `${kind}: ${detail}`,
        data: { level },
      })
      logWriter.append(path.join(app.getPath('userData'), 'internal-debug.log'), line)
    } catch {
      // best effort
    }
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    plog.warn('app', 'render-process-gone', { reason: details?.reason, exitCode: details?.exitCode })
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) stamp('error', 'console', `${message} (${sourceId}:${line})`)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    stamp('error', 'preload', `${preloadPath}: ${error instanceof Error ? error.message : String(error)}`)
  })
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  plog.warn('app', 'single-instance lock denied — quitting (another ST PLAY is running)')
  app.quit()
} else {
  plog.info('app', 'lock acquired, booting')
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault()
    callback(true)
  })

  app.whenReady().then(() => {
    coverCacheDir = path.join(app.getPath('userData'), 'cover-cache')
    fs.mkdirSync(coverCacheDir, { recursive: true })
    Menu.setApplicationMenu(null)
    // Sem handler, o Electron aprova TUDO: qualquer documento que chegue na
    // janela principal (e a navegação agora está travada) pediria media,
    // geolocation, notifications, pointerLock, clipboard-read, midi.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.setCertificateVerifyProc((_request, callback) => {
      callback(0)
    })
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      headers['User-Agent'] = 'VLC/3.0.20 LibVLC/3.0.20'
      try {
        const dest = new URL(details.url)
        if ((dest.protocol === 'http:' || dest.protocol === 'https:') && !headers.Referer) {
          headers.Referer = `${dest.origin}/`
        }
      } catch {
        // ignore
      }
      callback({ cancel: false, requestHeaders: sanitizeHeadersObject(headers) })
    })
    protocol.handle('sturplay', handleSturplay)
    updaterHost.registerUpdaterIpc()
    void ensureStreamProxy()
      .then(() => {
        createWindow()
      })
      .catch(() => {
        createWindow()
      })
  })

  let quitting = false
  app.on('before-quit', (event) => {
    /*
     * Durante a instalacao o quit NAO pode ser interceptado.
     *
     * O bloco abaixo faz `preventDefault()` e `app.exit(0)` para dar tempo de
     * derrubar o mpv e esvaziar o log. Numa atualizacao isso mataria o processo
     * no instante em que o `quitAndInstall` devolveu o controle — o instalador
     * nunca assumiria e a atualizacao fracassaria em silencio, sem erro visivel
     * em lugar nenhum. O app fecharia, abriria de novo, e continuaria na
     * versao antiga. O mpv desta sessao ja foi encerrado pelo proprio
     * `quitAndInstall`, que passa por `before-quit` do Electron.
     */
    if (updaterHost.isInstalando()) {
      plog.info('app', 'before-quitLiberado para instalacao')
      return
    }
    if (quitting) return
    plog.info('app', 'before-quit received')
    event.preventDefault()
    quitting = true
    try {
      playerHost.shutdownSync()
    } catch {
      // ignore
    }
    // Esvazia o buffer de log antes do exit. Sem isso, ate FLUSH_MS de linhas
    // somem — e o que some e justamente o fim da sessao, que e a parte que
    // alguem vai abrir o log para investigar.
    try {
      logWriter.closeAll()
    } catch {
      // ignore
    }
    app.exit(0)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
