/**
 * Proxy local com ffmpeg-static — modelo IPTV Player One (/t + pipe).
 * Uma instância ffmpeg por URL de destino; mpv consome via http://127.0.0.1/...
 */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { PassThrough } = require('stream')

let server = null
/** @type {string | null} */
let baseUrl = null
/** @type {Map<string, { sluit: () => void; proc: import('child_process').ChildProcess }>} */
const ffmpegPerTarget = new Map()

const IPTV_UA = 'VLC/3.0.20 LibVLC/3.0.20'

function resolveFfmpegPath() {
  const candidates = []
  try {
    const fromPkg = require('ffmpeg-static')
    if (fromPkg && typeof fromPkg === 'string') {
      candidates.push(fromPkg.replace(/app\.asar([/\\])/g, 'app.asar.unpacked$1'))
    }
  } catch {
    // ignore
  }
  try {
    const { app } = require('electron')
    candidates.push(path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
  } catch {
    // ignore
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  candidates.push(
    path.join(pf, 'IPTV Player One', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  )
  candidates.push(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

const FFMPEG_PATH = resolveFfmpegPath()

function encodeTarget(url) {
  return Buffer.from(url, 'utf8').toString('base64url')
}

function decodeTarget(token) {
  try {
    const url = Buffer.from(token, 'base64url').toString('utf8')
    return /^https?:\/\//i.test(url) ? url : null
  } catch {
    return null
  }
}

/**
 * Segredo por processo.
 *
 * O "token" do path era base64 da própria URL — não havia segredo nenhum, o
 * atacante computava o mesmo valor. E a resposta mandava
 * `Access-Control-Allow-Origin: *`, então qualquer página que achasse a porta
 * fazia a máquina do usuário spawnar ffmpeg contra QUALQUER URL (inclusive
 * hosts internos que a página não alcança) e lia os bytes remuxados
 * cross-origin. Pior: `stopOthers` matava a reprodução real do usuário, então
 * uma requisição sozinha também era um DoS.
 */
const PROXY_TOKEN = crypto.randomBytes(24).toString('hex')
const MAX_PARALLEL = 4

function tokenOk(incoming) {
  const t = incoming.searchParams.get('t')
  if (typeof t !== 'string' || t.length !== PROXY_TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(PROXY_TOKEN))
}

function httpRecoveryArgs() {
  return ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2']
}

function buildPassthroughArgs(targetUrl, startSec = 0) {
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-user_agent',
    IPTV_UA,
    '-rw_timeout',
    '15000000',
    ...httpRecoveryArgs(),
  ]
  if (startSec > 0) {
    args.push('-noaccurate_seek', '-ss', String(startSec))
  }
  let origin = ''
  try {
    origin = new URL(targetUrl).origin
  } catch {
    origin = ''
  }
  if (origin) {
    args.push('-headers', `Referer: ${origin}/\r\n`)
  }
  args.push('-i', targetUrl)
  args.push(
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-avoid_negative_ts',
    'make_non_negative',
    '-max_muxing_queue_size',
    '1024',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration',
    '500000',
    'pipe:1',
  )
  return args
}

function closeFfmpegForTarget(targetUrl) {
  ffmpegPerTarget.get(targetUrl)?.sluit()
}

function closeFfmpegForUrl(targetUrl) {
  closeFfmpegForTarget(targetUrl)
}

function attachRes(entry, res) {
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'cache-control': 'no-store',
    // `writeHead` ganha de `setHeader` para o mesmo nome, então o '*' que estava
    // AQUI anulava o 'null' que o handler punha antes. Metade do fix tinha
    // entrado (o token) e a metade que o comentário do arquivo justifica nao.
    'access-control-allow-origin': 'null',
  })
  entry.clients.add(res)
  entry.lastUse = Date.now()
  if (entry.reapTimer) {
    clearTimeout(entry.reapTimer)
    entry.reapTimer = null
  }
  entry.doorvoer.pipe(res, { end: false })
  const onClose = () => {
    try {
      entry.doorvoer.unpipe(res)
    } catch {
      // ignore
    }
    entry.clients.delete(res)
    try {
      if (!res.writableEnded) res.end()
    } catch {
      // ignore
    }
    if (entry.clients.size === 0 && !entry.reapTimer) {
      // Mantém o ffmpeg quente 30s pra re-zap instantâneo; depois mata
      entry.reapTimer = setTimeout(() => {
        try {
          entry.sluit()
        } catch {
          // ignore
        }
      }, 30000)
      if (entry.reapTimer.unref) entry.reapTimer.unref()
    }
  }
  res.on('close', onClose)
}

function evictOldestWarm() {
  try {
    const keys = [...ffmpegPerTarget.keys()]
    if (keys.length < 3) return
    let oldest = null
    let oldestUse = Infinity
    for (const key of keys) {
      const entry = ffmpegPerTarget.get(key)
      if (!entry) continue
      if (entry.clients.size > 0) continue
      if (entry.lastUse < oldestUse) {
        oldestUse = entry.lastUse
        oldest = key
      }
    }
    if (oldest) {
      try {
        ffmpegPerTarget.get(oldest)?.sluit()
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function stopOthers(exceptTarget) {
  // Painel de 1 tela: 2 inputs simultâneos = "already connected using a different IP".
  // Todo play novo mata os remuxes dos outros canais; só 1 conexão viva por vez.
  try {
    for (const key of [...ffmpegPerTarget.keys()]) {
      if (key === exceptTarget) continue
      try {
        ffmpegPerTarget.get(key)?.sluit()
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function startFfmpegStream(targetUrl, startSec, res, fresh) {
  if (!FFMPEG_PATH) {
    res.writeHead(503)
    res.end('ffmpeg-static indisponível')
    return
  }

  stopOthers(targetUrl)

  // Reusa pipe quente (mesmo target, sem seek e sem forçar novo).
  // Retry após falha pede fresh=1 pra não reaproveitar proc preso.
  if (!fresh && startSec === 0) {
    const warm = ffmpegPerTarget.get(targetUrl)
    if (warm && warm.proc && warm.proc.exitCode === null && warm.proc.killed !== true && warm.doorvoer) {
      attachRes(warm, res)
      return
    }
  }

  closeFfmpegForTarget(targetUrl)
  evictOldestWarm()

  const args = buildPassthroughArgs(targetUrl, startSec)
  const ffmpeg = spawn(FFMPEG_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  ffmpeg.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })

  const sluit = () => {
    try {
      ffmpeg.kill('SIGKILL')
    } catch {
      // ignore
    }
    if (ffmpegPerTarget.get(targetUrl)?.sluit === sluit) {
      ffmpegPerTarget.delete(targetUrl)
    }
  }

  ffmpegPerTarget.set(targetUrl, { sluit, proc: ffmpeg, doorvoer: null, clients: new Set(), lastUse: Date.now(), reapTimer: null })

  const doorvoer = new PassThrough({ highWaterMark: 2 * 1024 * 1024 })
  const entry = ffmpegPerTarget.get(targetUrl)
  if (entry) {
    entry.doorvoer = doorvoer
    // Pré-aquecido sem attach em 20s = ninguém quis, mata pra não vazar conexão
    if (entry.reapTimer) clearTimeout(entry.reapTimer)
    entry.reapTimer = setTimeout(() => {
      try {
        const cur = ffmpegPerTarget.get(targetUrl)
        if (cur && cur.clients.size === 0) cur.sluit()
      } catch {
        // ignore
      }
    }, 20000)
    if (entry.reapTimer.unref) entry.reapTimer.unref()
  }
  ffmpeg.stdout.pipe(doorvoer)
  attachRes(ffmpegPerTarget.get(targetUrl), res)

  const onProcEnd = () => {
    const current = ffmpegPerTarget.get(targetUrl)
    if (current) {
      for (const client of [...current.clients]) {
        try {
          current.doorvoer?.unpipe(client)
        } catch {
          // ignore
        }
        try {
          if (!client.writableEnded) client.end()
        } catch {
          // ignore
        }
      }
      current.clients.clear()
    }
  }
  const onClose = () => {
    onProcEnd()
    sluit()
  }
  res.on('close', () => {
    // attachRes já trata o desanexo; aqui só garante fim do pipe se proc morreu
  })
  ffmpeg.on('error', onClose)
  ffmpeg.on('close', (code) => {
    if (code !== 0 && code !== null) {
      try {
        const safe = String(targetUrl).replace(/(\/live\/)[^/]+\/[^/]+(\/.*)?/i, '$1*/*$2').slice(0, 120)
        console.error('[ffmpeg-proxy] exit', { code, target: safe, stderr: String(stderr || '').slice(-1200) })
      } catch {
        // ignore
      }
      try {
        if (!res.writableEnded) res.end()
      } catch {
        // ignore
      }
    }
    if (ffmpegPerTarget.get(targetUrl)?.sluit === sluit) {
      ffmpegPerTarget.delete(targetUrl)
    }
  })
}

function ensureStarted() {
  if (baseUrl) return Promise.resolve(baseUrl)
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      const incoming = new URL(req.url || '/', 'http://127.0.0.1')

      // Token ANTES do OPTIONS. Antes o preflight respondia 204 para qualquer
      // um, o que já confirmava que a porta existia e media cada canal morto.
      if (!tokenOk(incoming)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      res.setHeader('Access-Control-Allow-Origin', 'null')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const match = /^\/f\/([A-Za-z0-9_-]+)$/.exec(incoming.pathname)
      if (!match) {
        res.writeHead(404)
        res.end('not found')
        return
      }

      const target = decodeTarget(match[1])
      if (!target) {
        res.writeHead(400)
        res.end('bad url')
        return
      }

      // Teto de ffmpeg simultâneos. O reaper só descarta entradas com ZERO
      // clientes, então N requisições de um atacante mantinham N processos
      // vivos, cada um com conexão real para o host escolhido por ele.
      const existing = ffmpegPerTarget.get(target)
      if (!existing && ffmpegPerTarget.size >= MAX_PARALLEL) {
        res.writeHead(429)
        res.end('busy')
        return
      }

      const startSec = Math.max(0, Number(incoming.searchParams.get('start') || 0) || 0)
      const fresh = incoming.searchParams.get('fresh') === '1'
      startFfmpegStream(target, startSec, res, fresh)
    })

    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('STUR proxy não iniciou'))
        return
      }
      server = httpServer
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve(baseUrl)
    })
  })
}

async function wrapUrl(remoteUrl, startSec = 0, fresh = false) {
  const base = await ensureStarted()
  const start = Math.max(0, Math.round(startSec * 1000) / 1000)
  return `${base}/f/${encodeTarget(remoteUrl)}?start=${start}${fresh ? '&fresh=1' : ''}&t=${PROXY_TOKEN}`
}

function stop() {
  for (const entry of ffmpegPerTarget.values()) {
    try {
      entry.sluit()
    } catch {
      // ignore
    }
  }
  ffmpegPerTarget.clear()
  if (server) {
    try {
      server.close()
    } catch {
      // ignore
    }
  }
  server = null
  baseUrl = null
}

function isAvailable() {
  return Boolean(FFMPEG_PATH)
}

module.exports = {
  ensureStarted,
  wrapUrl,
  stop,
  isAvailable,
  encodeTarget,
  closeFfmpegForUrl,
}
