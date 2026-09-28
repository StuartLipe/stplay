/**
 * Valida mpv.exe (subprocess + IPC) e libmpv (embutido) no ST PLAY.
 * Uso: STPLAY_DEV_VALIDATE=1 STPLAY_DEV_OPEN="C:\path\1.mp4" npm run desktop
 */
const fs = require('fs')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const { app } = require('electron')
const { findMpv } = require('../find-player.cjs')
const libmpv = require('./libmpv-player.cjs')
const mpvExe = require('./mpv-exe-player.cjs')
const log = require('./player-log.cjs')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logPath() {
  return path.join(app.getPath('userData'), 'player.log')
}

function readLogSince(sinceIso) {
  try {
    const file = logPath()
    if (!fs.existsSync(file)) return []
    const since = Date.parse(sinceIso)
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter((entry) => entry && Date.parse(entry.at) >= since)
  } catch {
    return []
  }
}

/** Teste mpv.exe isolado: processo + pipe JSON, sem embed Electron. */
async function testMpvExeStandalone(filePath) {
  const mpvPath = findMpv()
  const result = {
    mode: 'mpv-exe-standalone',
    mpvPath,
    ok: false,
    ipcConnected: false,
    processAlive: false,
    commands: { load: false, pause: false, play: false, stop: false },
    properties: { dwidth: 0, dheight: 0, timePos: 0, paused: null },
    error: null,
  }

  if (!mpvPath) {
    result.error = 'mpv.exe não encontrado'
    return result
  }

  const playUrl = filePath.replace(/\\/g, '/')
  const pipePath = `\\\\.\\pipe\\stplay-validate-${process.pid}-${Date.now()}`
  let proc = null
  let socket = null
  let buf = ''
  let reqId = 0
  const pending = new Map()

  const send = (command) =>
    new Promise((resolve) => {
      if (!socket || socket.destroyed) {
        resolve(null)
        return
      }
      const id = ++reqId
      pending.set(id, resolve)
      socket.write(JSON.stringify({ command, request_id: id }) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          resolve(null)
        }
      }, 5000)
    })

  try {
    proc = spawn(
      mpvPath,
      [
        `--input-ipc-server=${pipePath}`,
        '--idle=yes',
        '--force-window=yes',
        '--no-terminal',
        '--geometry=640x360+100+100',
        '--osc=no',
        '--vo=gpu',
      ],
      { windowsHide: false, stdio: 'ignore' },
    )

    socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IPC timeout')), 8000)
      const tryConnect = () => {
        const s = net.connect(pipePath)
        s.once('connect', () => {
          clearTimeout(timer)
          resolve(s)
        })
        s.once('error', () => {
          s.destroy()
          setTimeout(tryConnect, 200)
        })
      }
      tryConnect()
    })

    result.ipcConnected = true
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          if (msg.request_id && pending.has(msg.request_id)) {
            const finish = pending.get(msg.request_id)
            pending.delete(msg.request_id)
            finish(msg)
          }
        } catch {
          // ignore
        }
      }
    })

    const loadRes = await send(['loadfile', playUrl, 'replace'])
    result.commands.load = Boolean(loadRes && loadRes.error === 'success')
    await sleep(4000)

    const w = await send(['get_property', 'dwidth'])
    const h = await send(['get_property', 'dheight'])
    const t = await send(['get_property', 'time-pos'])
    const p = await send(['get_property', 'pause'])
    result.properties.dwidth = w?.data ?? 0
    result.properties.dheight = h?.data ?? 0
    result.properties.timePos = typeof t?.data === 'number' ? t.data : 0
    result.properties.paused = p?.data ?? null

    const pauseRes = await send(['set_property', 'pause', true])
    result.commands.pause = Boolean(pauseRes && pauseRes.error === 'success')
    await sleep(800)
    const pausedAfter = await send(['get_property', 'pause'])
    result.commands.pauseEffective = pausedAfter?.data === true

    const playRes = await send(['set_property', 'pause', false])
    result.commands.play = Boolean(playRes && playRes.error === 'success')
    await sleep(800)

    const stopRes = await send(['stop'])
    result.commands.stop = Boolean(stopRes && stopRes.error === 'success')

    result.processAlive = proc && !proc.killed
    result.ok =
      result.ipcConnected &&
      result.commands.load &&
      result.properties.dwidth > 0 &&
      result.commands.pause &&
      result.commands.play
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      socket?.destroy()
    } catch {
      // ignore
    }
    if (proc?.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
  }

  return result
}

/**
 * @param {{ openFile: Function, stopAll: Function, command: Function }} playerHost
 * @param {import('electron').BrowserWindow} win
 */
async function runValidation(playerHost, win) {
  const filePath = process.env.STPLAY_DEV_OPEN
  if (!filePath) {
    console.log('[validate] STPLAY_DEV_OPEN não definido')
    return
  }

  const cb = win.getContentBounds()
  const bounds = { x: 0, y: 0, width: cb.width, height: Math.max(400, cb.height) }

  const report = {
    at: new Date().toISOString(),
    file: filePath,
    standalone: null,
    embedded: {
      mpvExe: null,
      libmpv: null,
    },
  }

  console.log('[validate] === mpv.exe standalone (processo + IPC) ===')
  report.standalone = await testMpvExeStandalone(filePath)
  console.log('[validate] standalone', JSON.stringify(report.standalone))

  const runEmbedded = async (engine, label) => {
    const startedAt = new Date().toISOString()
    log.info('validate', `start ${label}`)
    await playerHost.stopAll()
    await sleep(500)

    const open = await playerHost.openFile({ path: filePath, engine, bounds })
    await sleep(8000)

    let snapshot = null
    if (engine === 'libmpv' && open?.ok) {
      snapshot = libmpv.getPlaybackSnapshot?.() || null
    }

    let pauseRes = { ok: false }
    let playRes = { ok: false }
    if (open?.ok) {
      pauseRes = engine === 'libmpv' ? await libmpv.command('pause') : await mpvExe.command('pause')
      await sleep(1000)
      playRes = engine === 'libmpv' ? await libmpv.command('play') : await mpvExe.command('play')
      await sleep(1000)
    }

    let snapshotAfterPlay = null
    if (engine === 'libmpv') {
      snapshotAfterPlay = libmpv.getPlaybackSnapshot?.() || null
    }

    const stopRes = await playerHost.stopAll()
    const logs = readLogSince(startedAt)

    const entry = {
      engine,
      openOk: Boolean(open?.ok),
      openError: open?.error || null,
      engineReturned: open?.engine || engine,
      snapshotAfter8s: snapshot,
      commands: {
        pause: Boolean(pauseRes?.ok),
        play: Boolean(playRes?.ok),
        stop: Boolean(stopRes?.ok),
      },
      snapshotAfterPlay,
      decodeOk: Boolean(snapshot?.dwidth > 0 && snapshot?.timePos > 0.5),
      logs: logs.map((e) => `${e.scope}:${e.message}`).slice(-12),
      visualNote:
        engine === 'libmpv'
          ? 'HWND nativo — se Chromium opaco, tela preta com decode OK nos logs'
          : 'mpv.exe adotado via HWND — mesma limitação de composição Electron',
    }
    log.info('validate', `end ${label}`, entry)
    console.log(`[validate] ${label}`, JSON.stringify(entry))
    return entry
  }

  console.log('[validate] === mpv.exe embutido (ST PLAY playerHost) ===')
  report.embedded.mpvExe = await runEmbedded('mpv', 'mpv-embedded')
  await sleep(1000)

  console.log('[validate] === libmpv embutido (ST PLAY playerHost) ===')
  report.embedded.libmpv = await runEmbedded('libmpv', 'libmpv-embedded')

  const out = path.join(app.getPath('userData'), 'mpv-validation-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('[validate] REPORT_WRITTEN', out)
  console.log('[validate] done')

  setTimeout(() => {
    try {
      if (!win.isDestroyed()) win.close()
    } catch {
      // ignore
    }
    app.quit()
  }, 1500)
}

module.exports = { runValidation, testMpvExeStandalone }
