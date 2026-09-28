const http = require('http')
const crypto = require('crypto')
const { net } = require('electron')
const { sanitizeHeaderValue, sanitizeHeadersObject, safeResponseHeaders } = require('./latin1-headers.cjs')

let server = null
let port = 0

/**
 * Segredo por processo, exigido em toda requisição.
 *
 * O servidor escuta em 127.0.0.1 com porta efêmera, o que impede acesso externo
 * — mas qualquer página aberta no navegador do usuário podia descobrir a porta
 * (o 404 do path errado versus 400/200 é trivial de distinguir) e usava o app
 * como proxy CORS-bypass contra a LAN e o loopback, lendo a resposta
 * cross-origin por causa do `access-control-allow-origin: *`. Como o token vive
 * na URL que o main entrega ao renderer via `window.sturplay.proxyBase`, o
 * renderer segue usando a base que recebe e não precisa mudar nada.
 */
const PROXY_TOKEN = crypto.randomBytes(24).toString('hex')

/**
 * Só o dev server recebe eco. Qualquer outra origem recebe `null`, que é o
 * correto para a janela empacotada (file://) e bloqueia leitura cross-origin
 * por página arbitrária mesmo que ela descubra a porta.
 */
const DEV_ORIGINS = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

function devOrigin(req) {
  const origin = req && req.headers ? req.headers.origin : null
  if (typeof origin === 'string' && DEV_ORIGINS.test(origin)) return origin
  return 'null'
}

function tokenOk(incoming) {
  const t = incoming.searchParams.get('t')
  if (typeof t !== 'string' || t.length !== PROXY_TOKEN.length) return false
  // Comparação de tamanho fixo evita vazar por tempo.
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(PROXY_TOKEN))
}

function isAllowedTarget(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function buildUpstreamHeaders(dest, req) {
  const headers = sanitizeHeadersObject({
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
    Referer: `${dest.origin}/`,
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  })
  if (req.headers.range) {
    const range = sanitizeHeaderValue(req.headers.range)
    if (range) headers.Range = range
  }
  const accept = req.headers.accept
  if (accept && !/player_api\.php|\/get\.php/i.test(dest.href)) {
    const safeAccept = sanitizeHeaderValue(accept)
    if (safeAccept) headers.Accept = safeAccept
  }
  return headers
}

function guessStreamContentType(targetUrl, upstreamType) {
  const fromUpstream = upstreamType?.split(';')[0]?.trim()
  if (fromUpstream && fromUpstream !== 'application/octet-stream') return fromUpstream
  const lower = String(targetUrl || '').toLowerCase()
  if (/\.m3u8(\?|#|$)/.test(lower)) return 'application/vnd.apple.mpegURL'
  if (/\.ts(\?|#|$)/.test(lower)) return 'video/mp2t'
  if (/\.mp4(\?|#|$)/.test(lower)) return 'video/mp4'
  return fromUpstream || 'application/octet-stream'
}

async function pipeUpstream(req, res, targetUrl, opts = {}) {
  const dest = new URL(targetUrl)
  const upstream = await net.fetch(targetUrl, {
    method: 'GET',
    headers: buildUpstreamHeaders(dest, req),
    bypassCustomProtocolHandlers: true,
  })

  const outHeaders = sanitizeHeadersObject({
    // Não é mais `*`: o token já limita quem pode usar, e o CORS liberado deixava
    // qualquer página ler a resposta cross-origin.
    //
    // O valor tem de bater com a origem do renderer. Em produção a janela é
    // file:// (origem opaca) e a origem literal é `null`. Em dev o renderer é
    // http://localhost:5173 e o navegador manda `Origin:
    // http://localhost:5173` — devolver `null` lá barrava TODA chamada de API
    // no `npm run desktop`, sem mensagem. Então ecoamos a origem quando ela
    // existe e é o dev server, e `null` no empacotado.
    'access-control-allow-origin': devOrigin(req),
    'vary': 'Origin',
    'cache-control': 'no-store',
  })
  if (opts.streamDefaults) {
    // Nunca repassa Content-Length/Range do painel no live: painel com length
    // errado causava net::ERR_CONTENT_LENGTH_MISMATCH e retry de segundos.
    // Chunked sempre (igual mpv ignora length e segue o pipe).
    outHeaders['Content-Type'] =
      sanitizeHeaderValue(guessStreamContentType(targetUrl, upstream.headers.get('content-type'))) ||
      'application/octet-stream'
    outHeaders['Accept-Ranges'] = 'bytes'
  } else {
    const forwarded = safeResponseHeaders(upstream)
    for (const [key, value] of Object.entries(forwarded)) {
      const lower = key.toLowerCase()
      if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') continue
      outHeaders[key] = value
    }
  }

  res.writeHead(upstream.status || 200, sanitizeHeadersObject(outHeaders))
  if (!upstream.body) {
    res.end()
    return
  }

  const reader = upstream.body.getReader()
  const abort = () => {
    try {
      void reader.cancel()
    } catch {
      // ignore
    }
  }
  req.on('close', abort)
  res.on('close', abort)

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const ok = res.write(Buffer.from(value))
    if (!ok) await new Promise((r) => res.once('drain', r))
  }
  res.end()
}

function ensureStreamProxy() {
  if (server && port) return Promise.resolve(port)
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      try {
        const incoming = new URL(req.url || '/', 'http://127.0.0.1')

        if (!tokenOk(incoming)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }

        if (incoming.pathname === '/proxy') {
          const targetUrl = incoming.searchParams.get('url')
          if (!targetUrl || !isAllowedTarget(targetUrl)) {
            res.writeHead(400)
            res.end('bad url')
            return
          }
          await pipeUpstream(req, res, targetUrl)
          return
        }

        if (incoming.pathname === '/stream') {
          const targetUrl = incoming.searchParams.get('u')
          if (!targetUrl || !isAllowedTarget(targetUrl)) {
            res.writeHead(400)
            res.end('bad url')
            return
          }
          await pipeUpstream(req, res, targetUrl, { streamDefaults: true })
          return
        }

        res.writeHead(404)
        res.end('not found')
      } catch (error) {
        try {
          if (!res.headersSent) res.writeHead(502)
          res.end(error instanceof Error ? error.message : 'proxy failed')
        } catch {
          // ignore
        }
      }
    })

    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address()
      server = httpServer
      port = addr && typeof addr === 'object' ? addr.port : 0
      resolve(port)
    })
  })
}

function proxyBaseUrl() {
  return port ? `http://127.0.0.1:${port}/proxy?t=${PROXY_TOKEN}` : ''
}

async function localPlayUrl(remoteUrl) {
  const listenPort = await ensureStreamProxy()
  return `http://127.0.0.1:${listenPort}/stream?u=${encodeURIComponent(remoteUrl)}&t=${PROXY_TOKEN}`
}

/**
 * Segue 302 do painel (qualquer host) e devolve a URL final do CDN.
 * mpv sozinho costuma travar em HTTPS → HTTP + token.
 */
async function resolveRedirectUrl(remoteUrl) {
  if (!remoteUrl || !isAllowedTarget(remoteUrl)) return remoteUrl
  if (/127\.0\.0\.1/i.test(remoteUrl)) return remoteUrl
  try {
    const dest = new URL(remoteUrl)
    // Timeout: sem ele, um host lento pendura o start() do STUR depois do adopted (tela preta).
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    let res
    try {
      res = await net.fetch(remoteUrl, {
        method: 'GET',
        headers: sanitizeHeadersObject({
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
          Range: 'bytes=0-1',
          Referer: `${dest.origin}/`,
          Accept: '*/*',
        }),
        bypassCustomProtocolHandlers: true,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const finalUrl = typeof res.url === 'string' && res.url ? res.url : remoteUrl
    try {
      if (res.body && typeof res.body.cancel === 'function') void res.body.cancel()
    } catch {
      // ignore
    }
    if (res.status === 404 || res.status === 410) return null
    if (!isAllowedTarget(finalUrl)) return remoteUrl
    return finalUrl
  } catch {
    return remoteUrl
  }
}

module.exports = { ensureStreamProxy, localPlayUrl, proxyBaseUrl, resolveRedirectUrl }
