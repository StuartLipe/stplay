const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { app } = require('electron')
const { findMpc, findVlc, logPlayerSearch } = require('../find-player.cjs')
const log = require('./player-log.cjs')

/** @type {{ pid?: number } | null} */
let externalProcess = null

function killExternal(proc) {
  if (!proc) return
  try {
    if (proc.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(proc.pid)
      }
    }
  } catch {
    // ignore
  }
}

function hasVlc() {
  return Boolean(findVlc())
}

function hasMpc() {
  return Boolean(findMpc())
}

function listPlayers(url, startTime, preferred = 'vlc') {
  const start = typeof startTime === 'number' && startTime > 1 && Number.isFinite(startTime) ? Math.floor(startTime) : 0
  const vlcStart = start > 0 ? [`--start-time=${start}`] : []
  const mpcStart = start > 0 ? ['/start', String(Math.floor(start * 1000))] : []
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const vlcPath = findVlc()
  const mpcPath = findMpc()
  const vlcExtra = []
  if (origin && !/127\.0\.0\.1/i.test(url)) vlcExtra.push(`--http-referrer=${origin}/`)

  const byId = {
    vlc: vlcPath ? { id: 'vlc', command: vlcPath, args: [...vlcExtra, ...vlcStart], cwd: path.dirname(vlcPath) } : null,
    mpc: mpcPath ? { id: 'mpc', command: mpcPath, args: ['/play', ...mpcStart], cwd: path.dirname(mpcPath) } : null,
  }
  const order = preferred === 'mpc' ? ['mpc', 'vlc'] : ['vlc', 'mpc']
  const out = []
  const seen = new Set()
  for (const id of order) {
    const item = byId[id]
    if (!item || seen.has(item.command)) continue
    seen.add(item.command)
    out.push(item)
  }
  return out
}

function spawnPlayer(player, url) {
  return new Promise((resolve) => {
    const args = player.id === 'mpc' ? [...player.args, url] : [...player.args, '--', url]
    const cwd = player.cwd || path.dirname(player.command)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(player.command, args, {
        detached: true,
        stdio: 'ignore',
        cwd,
        windowsHide: false,
        shell: false,
        env: { ...process.env },
      })
      child.once('error', (error) => finish({ ok: false, error: error.message }))
      child.once('exit', (code) => finish({ ok: false, error: `exit ${code ?? '?'}` }))
      setTimeout(() => {
        if (settled) return
        if (child.exitCode != null || child.killed) {
          finish({ ok: false, error: 'process ended' })
          return
        }
        try {
          child.unref()
        } catch {
          // ignore
        }
        finish({ ok: true, pid: child.pid })
      }, 80)
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : 'spawn failed' })
    }
  })
}

function focusExternal(pid) {
  if (process.platform !== 'win32' || !pid) return
  const focusScript = [
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}'`,
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
    `if ($p -and $p.MainWindowHandle -ne 0) { [void][W]::ShowWindow($p.MainWindowHandle, 9); [void][W]::SetForegroundWindow($p.MainWindowHandle) }`,
  ].join('; ')
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', focusScript], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

async function start(engine, url, startTime, mainWindow, { minimize = true } = {}) {
  const preferred = engine === 'mpc' ? 'mpc' : 'vlc'
  const players = listPlayers(url, startTime, preferred)
  if (!players.length) {
    log.warn('external', 'no player found', { engine })
    return { ok: false, error: 'Player externo não encontrado' }
  }
  killExternal(externalProcess)
  externalProcess = null
  await new Promise((r) => setTimeout(r, 200))
  logPlayerSearch({ reason: 'external-player:start', engine, url })
  for (const player of players) {
    const result = await spawnPlayer(player, url)
    if (result.ok) {
      externalProcess = { pid: result.pid }
      if (minimize && mainWindow && !mainWindow.isDestroyed()) {
        try {
          if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
          mainWindow.minimize()
        } catch {
          // ignore
        }
      }
      focusExternal(result.pid)
      log.info('external', 'started', { engine: player.id, pid: result.pid })
      return { ok: true, engine: player.id, external: true }
    }
    log.warn('external', 'spawn failed', { player: player.command, error: result.error })
  }
  return { ok: false, error: 'Falha ao abrir player externo' }
}

function stop() {
  killExternal(externalProcess)
  externalProcess = null
  return { ok: true }
}

function getPid() {
  return externalProcess?.pid ?? null
}

module.exports = { hasVlc, hasMpc, start, stop, getPid, focusExternal }
