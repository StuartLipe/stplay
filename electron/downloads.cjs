const { app, dialog, BrowserWindow, shell, ipcMain, net } = require('electron')
const { vodUrlVariants } = require('./players/vod-url-variants.cjs')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const { spawn } = require('child_process')
const { findMpv } = require('./find-player.cjs')
const { sanitizeHeaderValue, sanitizeHeadersObject } = require('./latin1-headers.cjs')

/** @type {Map<string, any>} */
const active = new Map()
/** @type {string[]} */
const waitQueue = []
/** Filmes já baixam em paralelo; episódios usam MPV e também entram na fila. */
const MAX_CONCURRENT = 3

function countRunning() {
  let n = 0
  for (const entry of active.values()) {
    if (entry.running && !entry.paused) n += 1
  }
  return n
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Mesmos headers do proxy de streaming (Referer + UA VLC). */
function streamHeaders(url, extra = {}) {
  const origin = originOf(url)
  const headers = sanitizeHeadersObject({
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    Connection: 'keep-alive',
    ...extra,
  })
  if (origin) headers.Referer = `${origin}/`
  return headers
}

/**
 * Candidatos de URL para tentar em um download.
 *
 * Delega para `vodUrlVariants`, o MESMO helper que o player usa. Antes esta
 * funcao era uma copia local, e a copia driftou:
 *
 *   player    : mp4, mkv, avi, ts
 *   downloader: mp4, mkv            <-- sem ts, sem avi
 *
 * Um painel que serve o filme apenas como `.ts` abria no player e devolvia
 * 404 no download — que e o sintoma exato do job "VENUS" preso em COM ERRO.
 *
 * Delegar resolve o bug e remove a causa: nao existe mais segunda copia para
 * divergir no proximo formato novo. Serie ganha `m4v` de graca, que so o
 * player tinha.
 */
function buildCandidateUrls(url) {
  const variants = vodUrlVariants(url)
  return variants.length > 0 ? variants : [url]
}

function killProc(entry) {
  const proc = entry?.proc
  if (!proc || proc.killed) return
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }
  entry.proc = null
}

function removeFromQueue(id) {
  const key = String(id)
  for (let i = waitQueue.length - 1; i >= 0; i -= 1) {
    if (waitQueue[i] === key) waitQueue.splice(i, 1)
  }
}

function enqueueOrStart(id, startAt = 0) {
  const entry = active.get(id)
  if (!entry || entry.paused) return
  if (countRunning() >= MAX_CONCURRENT) {
    if (!waitQueue.includes(id)) waitQueue.push(id)
    entry.running = false
    sendProgress({
      id,
      status: 'queued',
      received: entry.received || 0,
      total: entry.total || 0,
      speed: 0,
      filePath: entry.filePath,
    })
    return
  }
  entry.running = true
  sendProgress({
    id,
    status: 'downloading',
    received: entry.received || 0,
    total: entry.total || 0,
    speed: 0,
    filePath: entry.filePath,
  })
  void startTransfer(id, startAt)
}

function pumpQueue() {
  while (countRunning() < MAX_CONCURRENT && waitQueue.length > 0) {
    const id = waitQueue.shift()
    const entry = active.get(id)
    if (!entry || entry.paused) continue
    entry.running = true
    sendProgress({
      id,
      status: 'downloading',
      received: entry.received || 0,
      total: entry.total || 0,
      speed: 0,
      filePath: entry.filePath,
    })
    void startTransfer(id, entry.received || 0)
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'download-settings.json')
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function getDownloadFolder() {
  const cfg = readConfig()
  if (cfg.folder && typeof cfg.folder === 'string' && fs.existsSync(cfg.folder)) {
    return cfg.folder
  }
  const fallback = path.join(app.getPath('downloads'), 'ST PLAY')
  try {
    fs.mkdirSync(fallback, { recursive: true })
  } catch {
    // ignore
  }
  return fallback
}

function sanitizeName(name) {
  return (
    String(name || 'video')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video'
  )
}

function uniquePath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}.${ext}`)
  if (!fs.existsSync(candidate)) return candidate
  for (let i = 1; i < 9999; i += 1) {
    candidate = path.join(dir, `${baseName} (${i}).${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${baseName}-${Date.now()}.${ext}`)
}

function getMainWindow() {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null
}

function sendProgress(payload) {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('downloads:progress', payload)
  }
}

/** Usa o net do Electron (mesmo stack do Chromium, aceita SSL ruim de IPTV). */
function followDownload(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('Muitos redirecionamentos'))
      return
    }
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }

    let req
    try {
      req = net.request({
        method: 'GET',
        url,
        redirect: 'manual',
      })
    } catch (error) {
      finish(error)
      return
    }

    const merged = streamHeaders(url, headers)
    for (const [key, value] of Object.entries(merged)) {
      const safe = sanitizeHeaderValue(value)
      if (safe != null && safe !== '') req.setHeader(key, safe)
    }

    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        // ignore
      }
      finish(Object.assign(new Error('Timeout na conexão'), { statusCode: 408 }))
    }, 45000)

    req.on('redirect', (statusCode, method, redirectUrl) => {
      clearTimeout(timer)
      if (!redirectUrl) {
        finish(Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }))
        return
      }
      let next
      try {
        next = new URL(redirectUrl, url).toString()
      } catch {
        finish(new Error('Redirecionamento inválido'))
        return
      }
      try {
        req.abort()
      } catch {
        // ignore
      }
      followDownload(next, headers, redirects + 1).then(
        (value) => finish(null, value),
        (error) => finish(error),
      )
    })

    req.on('response', (res) => {
      clearTimeout(timer)
      const code = res.statusCode || 0
      if (code >= 300 && code < 400) {
        const location = res.headers.location
        const loc = Array.isArray(location) ? location[0] : location
        res.resume()
        if (!loc) {
          finish(Object.assign(new Error(`HTTP ${code}`), { statusCode: code }))
          return
        }
        const next = new URL(loc, url).toString()
        followDownload(next, headers, redirects + 1).then(
          (value) => finish(null, value),
          (error) => finish(error),
        )
        return
      }
      if (code < 200 || code >= 300) {
        res.resume()
        const friendly =
          code === 521
            ? 'HTTP 521 — servidor do provedor fora do ar. Tente outro episódio ou mais tarde.'
            : code === 502 || code === 503
              ? `HTTP ${code} — gateway do provedor falhou. Tente de novo em instantes.`
              : `HTTP ${code}`
        finish(Object.assign(new Error(friendly), { statusCode: code }))
        return
      }
      finish(null, { res, req })
    })

    req.on('error', (error) => {
      clearTimeout(timer)
      finish(error)
    })

    req.end()
  })
}

async function followDownloadWithRetry(url, headers, attempts = 4) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await followDownload(url, headers)
    } catch (error) {
      lastError = error
      const code = error && typeof error === 'object' ? error.statusCode : 0
      const msg = error instanceof Error ? error.message : ''
      const retryable =
        code === 502 ||
        code === 503 ||
        code === 504 ||
        code === 408 ||
        code === 520 ||
        code === 521 ||
        code === 522 ||
        code === 523 ||
        code === 524 ||
        /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)
      if (!retryable || i === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 900 * (i + 1)))
    }
  }
  throw lastError || new Error('Falha ao baixar')
}

/**
 * Baixa com MPV (mesmo caminho da reprodução) — necessário para HLS / CDN de séries.
 * @returns {'completed'|'paused'|'error'|'unavailable'}
 */
function runMpvDump(id) {
  const entry = active.get(id)
  if (!entry) return Promise.resolve('unavailable')

  const mpv = findMpv()
  if (!mpv) return Promise.resolve('unavailable')

  // Stream copy funciona melhor em MKV (HEVC/HLS comum em anime).
  if (!/\.mkv$/i.test(entry.filePath)) {
    const dir = path.dirname(entry.filePath)
    const base = path.basename(entry.filePath, path.extname(entry.filePath))
    entry.filePath = uniquePath(dir, base, 'mkv')
  }

  try {
    if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath)
  } catch {
    // ignore
  }

  entry.mode = 'mpv'
  entry.received = 0
  entry.total = 0

  const origin = originOf(entry.url)
  const args = [
    '--no-terminal',
    '--no-config',
    '--force-window=no',
    '--idle=no',
    '--keep-open=no',
    '--cache=yes',
    '--demuxer-max-bytes=200MiB',
    '--hls-bitrate=max',
    '--user-agent=VLC/3.0.20 LibVLC/3.0.20',
    `--o=${entry.filePath}`,
    '--of=matroska',
    '--ovc=copy',
    '--oac=copy',
  ]
  if (origin) args.push(`--referrer=${origin}/`)
  args.push(entry.url)

  return new Promise((resolve) => {
    let settled = false
    let poll = 0
    let lastBytes = 0
    let lastAt = Date.now()
    let stderr = ''

    const finish = (result) => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      killProc(entry)
      resolve(result)
    }

    let proc
    try {
      proc = spawn(mpv, args, {
        cwd: path.dirname(mpv),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      finish('unavailable')
      return
    }

    entry.proc = proc
    proc.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-800)
    })

    sendProgress({
      id,
      status: 'downloading',
      received: 0,
      total: 0,
      speed: 0,
      filePath: entry.filePath,
    })

    poll = setInterval(() => {
      if (entry.paused) {
        finish('paused')
        return
      }
      let size = 0
      try {
        if (fs.existsSync(entry.filePath)) size = fs.statSync(entry.filePath).size
      } catch {
        size = entry.received || 0
      }
      const now = Date.now()
      const dt = Math.max(0.25, (now - lastAt) / 1000)
      const speed = Math.max(0, (size - lastBytes) / dt)
      lastBytes = size
      lastAt = now
      entry.received = size
      sendProgress({
        id,
        status: 'downloading',
        received: size,
        total: entry.total || 0,
        speed,
        filePath: entry.filePath,
      })
    }, 400)

    proc.on('error', () => {
      entry.running = false
      sendProgress({
        id,
        status: 'error',
        error: 'Não foi possível iniciar o MPV para baixar o episódio.',
        received: entry.received,
        total: entry.total,
        speed: 0,
        filePath: entry.filePath,
      })
      active.delete(id)
      pumpQueue()
      finish('error')
    })

    proc.on('close', (code) => {
      if (settled && entry.paused) {
        entry.running = false
        pumpQueue()
        return
      }
      if (entry.paused) {
        entry.running = false
        pumpQueue()
        finish('paused')
        return
      }

      let size = 0
      try {
        if (fs.existsSync(entry.filePath)) size = fs.statSync(entry.filePath).size
      } catch {
        // ignore
      }
      entry.received = size

      if (code === 0 && size > 64 * 1024) {
        entry.running = false
        sendProgress({
          id,
          status: 'completed',
          received: size,
          total: size,
          speed: 0,
          filePath: entry.filePath,
        })
        active.delete(id)
        pumpQueue()
        finish('completed')
        return
      }

      // MPV falhou — deixa HTTP tentar (unavailable) se arquivo vazio
      if (size < 64 * 1024) {
        try {
          if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath)
        } catch {
          // ignore
        }
        entry.received = 0
        entry.mode = null
        finish('unavailable')
        return
      }

      entry.running = false
      const tip = /403|401|denied/i.test(stderr)
        ? 'Acesso negado pelo CDN do provedor.'
        : 'MPV encerrou antes de concluir o episódio.'
      sendProgress({
        id,
        status: 'error',
        error: tip,
        received: size,
        total: entry.total,
        speed: 0,
        filePath: entry.filePath,
      })
      active.delete(id)
      pumpQueue()
      finish('error')
    })
  })
}

function isHlsResponse(res, firstChunk) {
  const ctype = String(
    Array.isArray(res.headers['content-type'])
      ? res.headers['content-type'][0]
      : res.headers['content-type'] || '',
  ).toLowerCase()
  if (/mpegurl|m3u8|apple\.mpegurl|x-mpegURL/i.test(ctype)) return true
  if (firstChunk) {
    const head = Buffer.isBuffer(firstChunk)
      ? firstChunk.slice(0, 16).toString('utf8')
      : String(firstChunk).slice(0, 16)
    if (head.startsWith('#EXTM3U')) return true
  }
  return false
}

async function startTransfer(id, startAt = 0) {
  const entry = active.get(id)
  if (!entry) return

  entry.running = true
  const isSeries = /\/series\//i.test(entry.url)

  // Episódios: MPV primeiro (toca no player, mas URL costuma ser HLS/CDN).
  if (isSeries && startAt === 0) {
    const mpvResult = await runMpvDump(id)
    if (mpvResult === 'completed' || mpvResult === 'paused' || mpvResult === 'error') return
  }

  const candidates = buildCandidateUrls(entry.url)
  let lastError = null

  for (const candidate of candidates) {
    if (entry.paused) return
    const headers = {}
    if (startAt > 0) headers.Range = `bytes=${startAt}-`

    let res
    let req
    try {
      ;({ res, req } = await followDownloadWithRetry(candidate, headers, 2))
    } catch (error) {
      lastError = error
      continue
    }

    if (entry.paused) {
      try {
        req.abort?.()
      } catch {
        // ignore
      }
      try {
        res.resume?.()
      } catch {
        // ignore
      }
      return
    }

    if (isHlsResponse(res)) {
      try {
        req.abort?.()
      } catch {
        // ignore
      }
      try {
        res.resume?.()
      } catch {
        // ignore
      }
      entry.url = candidate
      const mpvResult = await runMpvDump(id)
      if (mpvResult === 'completed' || mpvResult === 'paused' || mpvResult === 'error') return
      lastError = new Error('Stream HLS — baixe de novo (MPV indisponível).')
      continue
    }

    entry.url = candidate
    entry.req = req
    entry.res = res
    entry.mode = 'http'

    const headerLen = res.headers['content-length']
    const contentLength = Number(Array.isArray(headerLen) ? headerLen[0] : headerLen || 0)
    if (startAt > 0 && res.statusCode === 206) {
      entry.total = startAt + contentLength
    } else if (contentLength > 0) {
      entry.total = contentLength
      entry.received = 0
    }

    const append = startAt > 0 && res.statusCode === 206
    if (!append) entry.received = 0

    const file = fs.createWriteStream(entry.filePath, { flags: append ? 'a' : 'w' })
    entry.file = file

    let lastBytes = entry.received
    let lastAt = Date.now()
    let lastEmit = 0
    let lastDataAt = Date.now()
    let stallTimer = 0
    let gotData = false
    let hlsChecked = false

    const clearStall = () => {
      if (stallTimer) {
        clearInterval(stallTimer)
        stallTimer = 0
      }
    }

    const emit = (status = 'downloading') => {
      const now = Date.now()
      const dt = Math.max(0.25, (now - lastAt) / 1000)
      const speed = Math.max(0, (entry.received - lastBytes) / dt)
      lastBytes = entry.received
      lastAt = now
      sendProgress({
        id,
        status,
        received: entry.received,
        total: entry.total,
        speed,
        filePath: entry.filePath,
      })
    }

    emit('downloading')

    const done = await new Promise((resolve) => {
      const fail = (message) => {
        if (entry.paused) {
          resolve('paused')
          return
        }
        clearStall()
        try {
          file.destroy?.()
        } catch {
          // ignore
        }
        resolve({ error: message })
      }

      stallTimer = setInterval(() => {
        if (entry.paused) return
        if (Date.now() - lastDataAt < (gotData ? 25000 : 12000)) return
        clearStall()
        try {
          req.abort?.()
        } catch {
          // ignore
        }
        try {
          file.destroy?.()
        } catch {
          // ignore
        }
        resolve(gotData ? { error: 'Download sem dados (servidor parou de enviar). Tente de novo.' } : 'retry')
      }, 2000)

      res.on('data', (chunk) => {
        if (entry.paused) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (!hlsChecked) {
          hlsChecked = true
          if (isHlsResponse(res, buf)) {
            clearStall()
            try {
              req.abort?.()
            } catch {
              // ignore
            }
            try {
              file.destroy?.()
            } catch {
              // ignore
            }
            resolve('hls')
            return
          }
        }
        gotData = true
        entry.received += buf.length
        lastDataAt = Date.now()
        const ok = file.write(buf)
        if (!ok) {
          res.pause?.()
          file.once('drain', () => res.resume?.())
        }
        const now = Date.now()
        if (now - lastEmit >= 350) {
          lastEmit = now
          emit('downloading')
        }
      })

      res.on('end', () => {
        clearStall()
        file.end()
      })

      file.on('finish', () => {
        if (entry.paused) {
          resolve('paused')
          return
        }
        clearStall()
        emit('completed')
        entry.running = false
        active.delete(id)
        resolve('completed')
        pumpQueue()
      })
      file.on('error', (error) => fail(error.message))
      res.on('error', (error) => fail(error.message || 'Falha no stream'))
    })

    if (done === 'completed' || done === 'paused') return
    if (done === 'hls') {
      try {
        if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath)
      } catch {
        // ignore
      }
      entry.received = 0
      const mpvResult = await runMpvDump(id)
      if (mpvResult === 'completed' || mpvResult === 'paused' || mpvResult === 'error') return
      lastError = new Error('Episódio em HLS — MPV necessário para baixar.')
      continue
    }
    if (done === 'retry') {
      lastError = new Error('Sem dados — tentando outro formato…')
      continue
    }
    if (done && done.error) {
      if (gotData) {
        entry.running = false
        sendProgress({
          id,
          status: 'error',
          error: done.error,
          received: entry.received,
          total: entry.total,
          speed: 0,
          filePath: entry.filePath,
        })
        active.delete(id)
        pumpQueue()
        return
      }
      lastError = new Error(done.error)
      continue
    }
  }

  if (entry.paused) return
  entry.running = false
  sendProgress({
    id,
    status: 'error',
    error: lastError instanceof Error ? lastError.message : 'Falha ao baixar episódio',
    received: entry.received,
    total: entry.total,
    speed: 0,
    filePath: entry.filePath,
  })
  active.delete(id)
  pumpQueue()
}

function registerDownloadsIpc() {
  ipcMain.handle('downloads:get-folder', () => ({ ok: true, path: getDownloadFolder() }))

  ipcMain.handle('downloads:pick-folder', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win || undefined, {
      title: 'Escolher pasta de download',
      defaultPath: getDownloadFolder(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true }
    }
    const folder = result.filePaths[0]
    writeConfig({ folder })
    return { ok: true, path: folder }
  })

  ipcMain.handle('downloads:set-folder', (_event, folder) => {
    if (typeof folder !== 'string' || !folder.trim()) {
      return { ok: false, error: 'Pasta inválida' }
    }
    try {
      fs.mkdirSync(folder, { recursive: true })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Não foi possível criar a pasta' }
    }
    writeConfig({ folder })
    return { ok: true, path: folder }
  })

  ipcMain.handle('downloads:open-folder', async (_event, folder) => {
    const target = typeof folder === 'string' && folder ? folder : getDownloadFolder()
    try {
      fs.mkdirSync(target, { recursive: true })
    } catch {
      // ignore
    }
    await shell.openPath(target)
    return { ok: true, path: target }
  })

  ipcMain.handle('downloads:reveal', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false }
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
      return { ok: true }
    }
    const dir = path.dirname(filePath)
    if (fs.existsSync(dir)) {
      await shell.openPath(dir)
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle('downloads:start', async (_event, payload) => {
    const id = String(payload?.id || '')
    const url = String(payload?.url || '')
    const name = sanitizeName(payload?.name)
    const ext = sanitizeName(payload?.extension || 'mp4').replace(/^\./, '') || 'mp4'
    if (!id || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Download inválido' }
    }
    if (active.has(id)) {
      return { ok: false, error: 'Já está baixando' }
    }

    const cfg = readConfig()
    let folder = getDownloadFolder()
    if (!cfg.folder) {
      const picked = await dialog.showOpenDialog(getMainWindow() || undefined, {
        title: 'Escolher pasta de download',
        defaultPath: folder,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (picked.canceled || !picked.filePaths[0]) {
        return { ok: false, canceled: true }
      }
      folder = picked.filePaths[0]
      writeConfig({ folder })
    }

    try {
      fs.mkdirSync(folder, { recursive: true })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Pasta inválida' }
    }

    const filePath = uniquePath(folder, name, ext)
    active.set(id, {
      req: null,
      res: null,
      file: null,
      proc: null,
      mode: null,
      paused: false,
      running: false,
      filePath,
      url,
      received: 0,
      total: 0,
    })

    sendProgress({
      id,
      status: countRunning() >= MAX_CONCURRENT ? 'queued' : 'downloading',
      received: 0,
      total: 0,
      speed: 0,
      filePath,
      folder,
    })

    enqueueOrStart(id, 0)
    return { ok: true, filePath, folder }
  })

  ipcMain.handle('downloads:pause', (_event, id) => {
    const entry = active.get(String(id))
    if (!entry || entry.paused) return { ok: false }
    entry.paused = true
    entry.running = false
    removeFromQueue(id)
    killProc(entry)
    try {
      entry.req?.abort?.()
    } catch {
      // ignore
    }
    try {
      entry.req?.destroy?.()
    } catch {
      // ignore
    }
    try {
      entry.file?.end?.()
    } catch {
      // ignore
    }
    entry.req = null
    entry.res = null
    entry.file = null
    sendProgress({
      id,
      status: 'paused',
      received: entry.received,
      total: entry.total,
      speed: 0,
      filePath: entry.filePath,
    })
    pumpQueue()
    return { ok: true }
  })

  ipcMain.handle('downloads:resume', (_event, id) => {
    const key = String(id)
    const entry = active.get(key)
    if (!entry) return { ok: false, error: 'Download não encontrado' }
    if (!entry.paused) return { ok: false }
    entry.paused = false
    // Dump MPV não retoma por Range — reinicia o arquivo.
    if (entry.mode === 'mpv' || /\/series\//i.test(entry.url)) {
      entry.received = 0
      try {
        if (entry.filePath && fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath)
      } catch {
        // ignore
      }
    } else {
      try {
        if (entry.filePath && fs.existsSync(entry.filePath)) {
          entry.received = fs.statSync(entry.filePath).size
        }
      } catch {
        // keep previous received
      }
    }
    enqueueOrStart(key, entry.received)
    return { ok: true }
  })

  ipcMain.handle('downloads:cancel', (_event, id) => {
    const key = String(id)
    const entry = active.get(key)
    if (!entry) return { ok: false }
    entry.paused = true
    entry.running = false
    removeFromQueue(key)
    killProc(entry)
    try {
      entry.req?.abort?.()
    } catch {
      // ignore
    }
    try {
      entry.req?.destroy?.()
    } catch {
      // ignore
    }
    try {
      entry.file?.destroy?.()
    } catch {
      // ignore
    }
    active.delete(key)
    try {
      if (entry.filePath && fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath)
    } catch {
      // ignore
    }
    sendProgress({ id: key, status: 'canceled', received: 0, total: 0, speed: 0 })
    pumpQueue()
    return { ok: true }
  })
}

module.exports = { registerDownloadsIpc, getDownloadFolder }
