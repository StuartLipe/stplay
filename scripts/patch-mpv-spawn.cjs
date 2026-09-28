const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'electron', 'main.cjs')
let source = fs.readFileSync(target, 'utf8')

const start = source.indexOf('const MPV_QUALITY_ARGS')
const end = source.indexOf("ipcMain.handle('native-player:open'")
if (start < 0 || end < 0) {
  console.error('markers not found', { start, end })
  process.exit(1)
}

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
  '--tls-verify=no',
  '--keep-open=always',
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
  // Evita --referrer=https://... virar "arquivo" na cmdline do Windows
  const mpvHeaders = origin
    ? [\`--http-header-fields=Referer: \${origin}/,User-Agent: VLC/3.0.20 LibVLC/3.0.20\`]
    : []
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

  add(findMpv(), [...MPV_QUALITY_ARGS, ...mpvHeaders, ...mpvStart])
  add(findMpc(), [])
  add(findVlc(), ['--intf', 'qt', '--no-video-title-show', ...vlcStart])

  return candidates
}

function spawnNativePlayer(player, url) {
  return new Promise((resolve) => {
    // \`--\` garante que a URL nao seja lida como opcao
    const args = [...player.args, '--', url]
    const cwd = player.cwd || path.dirname(player.command)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      // Spawn com argv real. Start-Process do PowerShell perdia a URL -> "No file - mpv".
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
      }, 1500)
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })
    }
  })
}

`

// The template above used escaped backticks incorrectly when written as a string in this file.
// Build replacement without nested template confusion:
const lines = []
lines.push(`const MPV_QUALITY_ARGS = [`)
lines.push(`  '--force-window=immediate',`)
lines.push(`  '--no-terminal',`)
lines.push(`  '--hwdec=auto',`)
lines.push(`  '--vo=gpu',`)
lines.push(`  '--keepaspect=yes',`)
lines.push(`  '--hls-bitrate=max',`)
lines.push(`  '--cache=yes',`)
lines.push(`  '--demuxer-max-bytes=200MiB',`)
lines.push(`  '--user-agent=VLC/3.0.20 LibVLC/3.0.20',`)
lines.push(`  '--tls-verify=no',`)
lines.push(`  '--keep-open=always',`)
lines.push(`]`)
lines.push(``)
lines.push(`function killNativePlayer(proc) {`)
lines.push(`  if (!proc) return`)
lines.push(`  try {`)
lines.push(`    if (proc.pid) {`)
lines.push(`      if (process.platform === 'win32') {`)
lines.push(`        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })`)
lines.push(`      } else {`)
lines.push(`        process.kill(proc.pid)`)
lines.push(`      }`)
lines.push(`    } else if (typeof proc.kill === 'function') {`)
lines.push(`      proc.kill()`)
lines.push(`    }`)
lines.push(`  } catch {`)
lines.push(`    // ignore`)
lines.push(`  }`)
lines.push(`}`)
lines.push(``)
lines.push(`function listNativePlayers(url, startTime) {`)
lines.push(`  const start = typeof startTime === 'number' && startTime > 1 && Number.isFinite(startTime) ? Math.floor(startTime) : 0`)
lines.push(`  const vlcStart = start > 0 ? [\`--start-time=\${start}\`] : []`)
lines.push(`  const mpvStart = start > 0 ? [\`--start=\${start}\`] : []`)
lines.push(`  let origin = ''`)
lines.push(`  try {`)
lines.push(`    origin = new URL(url).origin`)
lines.push(`  } catch {`)
lines.push(`    origin = ''`)
lines.push(`  }`)
lines.push(`  // Evita --referrer=https://... virar "arquivo" na cmdline do Windows`)
lines.push(`  const mpvHeaders = origin`)
lines.push(`    ? [\`--http-header-fields=Referer: \${origin}/,User-Agent: VLC/3.0.20 LibVLC/3.0.20\`]`)
lines.push(`    : []`)
lines.push(`  const candidates = []`)
lines.push(``)
lines.push(`  const add = (command, args) => {`)
lines.push(`    if (!command) return`)
lines.push(`    if (candidates.some((item) => item.command === command)) return`)
lines.push(`    candidates.push({`)
lines.push(`      command,`)
lines.push(`      args,`)
lines.push(`      cwd: command.includes('\\\\') || command.includes('/') ? path.dirname(command) : undefined,`)
lines.push(`    })`)
lines.push(`  }`)
lines.push(``)
lines.push(`  add(findMpv(), [...MPV_QUALITY_ARGS, ...mpvHeaders, ...mpvStart])`)
lines.push(`  add(findMpc(), [])`)
lines.push(`  add(findVlc(), ['--intf', 'qt', '--no-video-title-show', ...vlcStart])`)
lines.push(``)
lines.push(`  return candidates`)
lines.push(`}`)
lines.push(``)
lines.push(`function spawnNativePlayer(player, url) {`)
lines.push(`  return new Promise((resolve) => {`)
lines.push(`    // \`--\` garante que a URL nao seja lida como opcao`)
lines.push(`    const args = [...player.args, '--', url]`)
lines.push(`    const cwd = player.cwd || path.dirname(player.command)`)
lines.push(`    let settled = false`)
lines.push(`    const finish = (result) => {`)
lines.push(`      if (settled) return`)
lines.push(`      settled = true`)
lines.push(`      resolve(result)`)
lines.push(`    }`)
lines.push(``)
lines.push(`    try {`)
lines.push(`      // Spawn com argv real. Start-Process do PowerShell perdia a URL -> "No file - mpv".`)
lines.push(`      const child = spawn(player.command, args, {`)
lines.push(`        detached: true,`)
lines.push(`        stdio: 'ignore',`)
lines.push(`        cwd,`)
lines.push(`        windowsHide: false,`)
lines.push(`        shell: false,`)
lines.push(`        env: { ...process.env },`)
lines.push(`      })`)
lines.push(`      child.once('error', (error) => {`)
lines.push(`        finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })`)
lines.push(`      })`)
lines.push(`      child.once('exit', (code) => {`)
lines.push(`        finish({ ok: false, error: \`Player encerrou na abertura (codigo \${code ?? '?'}).\` })`)
lines.push(`      })`)
lines.push(`      setTimeout(() => {`)
lines.push(`        if (settled) return`)
lines.push(`        if (child.exitCode != null || child.killed) {`)
lines.push(`          finish({ ok: false, error: 'Player nao permaneceu aberto.' })`)
lines.push(`          return`)
lines.push(`        }`)
lines.push(`        try {`)
lines.push(`          child.unref()`)
lines.push(`        } catch {`)
lines.push(`          // ignore`)
lines.push(`        }`)
lines.push(`        finish({ ok: true, child: { pid: child.pid } })`)
lines.push(`      }, 1500)`)
lines.push(`    } catch (error) {`)
lines.push(`      finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })`)
lines.push(`    }`)
lines.push(`  })`)
lines.push(`}`)
lines.push(``)
lines.push(``)

const out = source.slice(0, start) + lines.join('\n') + source.slice(end)
fs.writeFileSync(target, out)
console.log('patched', target)
