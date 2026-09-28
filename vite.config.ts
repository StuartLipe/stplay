import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

type ProxiedRequest = IncomingMessage & { originalUrl?: string }

function streamProxy(): Plugin {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = `http://${req.headers.host ?? 'localhost'}`
    const raw = (req as ProxiedRequest).originalUrl ?? req.url ?? '/'
    const target = new URL(raw, origin).searchParams.get('url')
    if (!target) {
      res.statusCode = 400
      res.end('missing url')
      return
    }

    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      res.statusCode = 400
      res.end('invalid url')
      return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.statusCode = 400
      res.end('unsupported protocol')
      return
    }

    const headers: Record<string, string> = {
      // Mesmo UA do Electron / IPTV Expert — browser UA costuma levar 429 no painel
      'user-agent': 'VLC/3.0.20 LibVLC/3.0.20',
      referer: `${parsed.origin}/`,
      accept: '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
    }
    if (req.headers.range) headers.range = String(req.headers.range)
    if (req.headers.accept && !/player_api\.php|\/get\.php/i.test(parsed.href)) {
      headers.accept = String(req.headers.accept)
    }

    try {
      const upstream = await fetch(parsed, { headers, redirect: 'follow' })
      const skip = new Set(['content-encoding', 'content-length', 'connection', 'transfer-encoding'])
      const out: Record<string, string> = {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      }
      upstream.headers.forEach((value, key) => {
        if (!skip.has(key.toLowerCase())) out[key] = value
      })
      res.writeHead(upstream.status, out)
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      const write = async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!res.write(Buffer.from(value))) {
            await new Promise((resolve) => res.once('drain', resolve))
          }
        }
        res.end()
      }
      req.on('close', () => {
        reader.cancel().catch(() => undefined)
      })
      await write()
    } catch (error) {
      res.statusCode = 502
      res.end(error instanceof Error ? error.message : 'proxy failed')
    }
  }

  return {
    name: 'sturplay-proxy',
    configureServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => {
        void handle(req, res)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => {
        void handle(req, res)
      })
    },
  }
}

/**
 * Injeta a CSP no HTML de produção.
 *
 * Fica no plugin, e não em index.html, porque o Vite dev injeta um script
 * inline do React Refresh: um `script-src 'self'` no index.html quebraria o
 * `npm run desktop`. No build não existe script inline, então a política pode
 * ser estrita. O dev é só localhost, então a ausência de CSP nele não expõe
 * nada — e a janela do Electron não tem `webSecurity` desligado.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https: sturplay:",
  "connect-src 'self' http: https: sturplay:",
  // O hls.js cria o transmuxer como Worker a partir de um Blob. Sem worker-src
  // blob:, o CSP resolve worker-src -> child-src -> script-src -> default-src,
  // todos 'self', e o worker é recusado. O hls.js engole a violação e cai para
  // transmux inline na main thread — todo segmento TS passa a ser reprocessado
  // no hilo da UI, o que aparece como travada, e pior em 1080i. Confirmado
  // pelo CSP validator + createHls (enableWorker: true) em src/lib/player.ts.
  "worker-src 'self' blob:",
  "child-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

function cspInject(): Plugin {
  return {
    name: 'csp-inject',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(
          /<meta charset="UTF-8"\s*\/>/i,
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        ),
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), streamProxy(), cspInject()],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    watch: {
      ignored: ['**/release/**', '**/dist/**'],
    },
  },
})
