const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'electron', 'main.cjs')
let src = fs.readFileSync(target, 'utf8')

if (!src.includes("const http = require('http')")) {
  src = src.replace(
    "const { spawn } = require('child_process')",
    "const { spawn } = require('child_process')\nconst http = require('http')",
  )
}

if (!src.includes('let streamProxyServer')) {
  src = src.replace(
    'let nativePlayerProcess = null',
    `let nativePlayerProcess = null
let streamProxyServer = null
let streamProxyPort = 0`,
  )
}

const oldArgsStart = src.indexOf('const MPV_QUALITY_ARGS = [')
const oldOpenStart = src.indexOf("ipcMain.handle('native-player:open'")
if (oldArgsStart < 0 || oldOpenStart < 0) {
  console.error('markers missing')
  process.exit(1)
}

// Find end of spawnNativePlayer - just before ipcMain.handle native-player:open
const replacement = `const MPV_QUALITY_ARGS = [
  '--force-window=immediate',
  '--no-terminal',
  '--hwdec=auto',
  '--vo=gpu',
  '--keepaspect=yes',
  '--hls-bitrate=max',
  '--cache=yes',
  '--demuxer-max-bytes=200MiB',
  '--user-agent=VLC/3.0.20 LibVLC/3.0.20',
  '--no-tls-verify',
  '--keep-open=yes',
  '--network-timeout=60',
]

function killNativePlayer(proc) {
  if (!proc) return
  try {
    if (proc.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(proc.pid)
      }
    } else if (typeof proc.kill === 'function') {
      proc.kill()
    }
  } catch {
    // ignore
  }
}

function ensureStreamProxy() {
  if (streamProxyServer && streamProxyPort) return Promise.resolve(streamProxyPort)
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const incoming = new URL(req.url || '/', 'http://127.0.0.1')
        if (incoming.pathname !== '/stream') {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const targetUrl = incoming.searchParams.get('u')
        if (!targetUrl || !/^https?:\\/\\//i.test(targetUrl)) {
          res.writeHead(400)
          res.end('bad url')
          return
        }
        let dest
        try {
          dest = new URL(targetUrl)
        } catch {
          res.writeHead(400)
          res.end('bad url')
          return
        }
        const headers = {
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
          Referer: \`\${dest.origin}/\`,
          Accept: '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        }
        if (req.headers.range) headers.Range = req.headers.range
        const upstream = await net.fetch(targetUrl, {
          method: 'GET',
          headers,
          bypassCustomProtocolHandlers: true,
        })
        const outHeaders = {
          'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
          'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
          'Access-Control-Allow-Origin': '*',
        }
        const contentLength = upstream.headers.get('content-length')
        if (contentLength) outHeaders['Content-Length'] = contentLength
        const contentRange = upstream.headers.get('content-range')
        if (contentRange) outHeaders['Content-Range'] = contentRange
        res.writeHead(upstream.status || 200, outHeaders)
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
      } catch (error) {
        try {
          if (!res.headersSent) res.writeHead(502)
          res.end(error instanceof Error ? error.message : 'proxy failed')
        } catch {
          // ignore
        }
      }
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      streamProxyServer = server
      streamProxyPort = addr && typeof addr === 'object' ? addr.port : 0
      resolve(streamProxyPort)
    })
  })
}

async function localPlayUrl(remoteUrl) {
  const port = await ensureStreamProxy()
  return \`http://127.0.0.1:\${port}/stream?u=\${encodeURIComponent(remoteUrl)}\`
}

function listNativePlayers(url, startTime) {
  const start = typeof startTime === 'number' && startTime > 1 && Number.isFinite(startTime) ? Math.floor(startTime) : 0
  const vlcStart = start > 0 ? [\`--start-time=\${start}\`] : []
  const mpvStart = start > 0 ? [\`--start=\${start}\`] : []
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const mpvExtra = []
  if (origin && !/^https?:\\/\\/127\\.0\\.0\\.1/i.test(url)) {
    mpvExtra.push(\`--referrer=\${origin}/\`)
  }
  const candidates = []
  const add = (command, args) => {
    if (!command) return
    if (candidates.some((item) => item.command === command)) return
    candidates.push({
      command,
      args,
      cwd: command.includes('\\\\') || command.includes('/') ? path.dirname(command) : undefined,
    })
  }
  add(findMpv(), [...MPV_QUALITY_ARGS, ...mpvExtra, ...mpvStart])
  add(findMpc(), [])
  add(findVlc(), ['--intf', 'qt', '--no-video-title-show', ...vlcStart])
  return candidates
}

function spawnNativePlayer(player, url) {
  return new Promise((resolve) => {
    const logFile = path.join(app.getPath('userData'), 'mpv-open.log')
    const args = [...player.args, \`--log-file=\${logFile}\`, '--', url]
    const cwd = player.cwd || path.dirname(player.command)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      try {
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'player-open.log'),
          JSON.stringify({ at: new Date().toISOString(), command: player.command, args, url }, null, 2),
        )
      } catch {
        // ignore
      }
      const child = spawn(player.command, args, {
        detached: true,
        stdio: 'ignore',
        cwd,
        windowsHide: false,
        shell: false,
        env: { ...process.env },
      })
      child.once('error', (error) => {
        finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })
      })
      child.once('exit', (code) => {
        finish({ ok: false, error: \`Player encerrou na abertura (codigo \${code ?? '?'}).\` })
      })
      setTimeout(() => {
        if (settled) return
        if (child.exitCode != null || child.killed) {
          finish({ ok: false, error: 'Player nao permaneceu aberto.' })
          return
        }
        try {
          child.unref()
        } catch {
          // ignore
        }
        finish({ ok: true, child: { pid: child.pid } })
      }, 1800)
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })
    }
  })
}

`

// The replacement above used escaped template strings incorrectly because this file itself is a template.
// Build with a plain string file instead.

console.log('use second approach')
