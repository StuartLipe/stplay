const fs = require('fs')
const path = require('path')
const { app } = require('electron')
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

function summarizeLogs(entries) {
  const scopes = entries.map((e) => `${e.scope}:${e.message}`)
  return {
    count: entries.length,
    hasFileLoaded: entries.some((e) => e.message === 'FILE_LOADED'),
    hasEngineStarted: entries.some((e) => e.message === 'engine started'),
    hasAutoSuccess: entries.some((e) => e.message === 'auto success'),
    hasFailed: entries.some((e) => e.message === 'failed' || e.message === 'auto try failed'),
    hasDimensions: entries.some((e) => e.message === 'FILE_LOADED' && e.data?.dwidth > 0),
    dimensions: entries.find((e) => e.message === 'playback-snapshot')?.data || null,
    lines: scopes,
  }
}

/**
 * @param {{ openFile: Function, stopAll: Function }} playerHost
 * @param {import('electron').BrowserWindow} win
 */
async function runPlayerTests(playerHost, win) {
  const filePath = process.env.STPLAY_DEV_OPEN
  if (!filePath) {
    console.log('[dev-test] STPLAY_DEV_OPEN não definido')
    return
  }

  const libmpv = require('./libmpv-player.cjs')
  const report = {
    at: new Date().toISOString(),
    file: filePath,
    tests: [],
  }

  const runCase = async (name, fn) => {
    const startedAt = new Date().toISOString()
    log.info('dev-test', `case start: ${name}`)
    let result = { ok: false, error: 'not run' }
    try {
      result = await fn()
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    await sleep(500)
    const logs = readLogSince(startedAt)
    const summary = summarizeLogs(logs)
    let snapshot = null
    try {
      snapshot = libmpv.getPlaybackSnapshot?.() || null
    } catch {
      snapshot = null
    }
    const entry = {
      name,
      ok: Boolean(result?.ok),
      engine: result?.engine || null,
      error: result?.error || null,
      logs: summary,
      snapshot,
    }
    report.tests.push(entry)
    log.info('dev-test', `case end: ${name}`, entry)
    console.log(`[dev-test] ${name}`, JSON.stringify(entry))
    await playerHost.stopAll()
    await sleep(800)
  }

  // 1) libmpv manual
  await runCase('libmpv-manual', async () => {
    const open = await playerHost.openFile({ path: filePath, engine: 'libmpv' })
    await sleep(8000)
    return open
  })

  // 2) modo automático
  await runCase('auto-chain', async () => {
    const open = await playerHost.openFile({ path: filePath, engine: 'auto' })
    await sleep(8000)
    return open
  })

  // 3) stop — abre e para em 2s
  await runCase('stop', async () => {
    const open = await playerHost.openFile({ path: filePath, engine: 'libmpv' })
    await sleep(2000)
    const stopped = await playerHost.stopAll()
    return { ok: open?.ok && stopped?.ok !== false, engine: 'libmpv', stopped: true }
  })

  const out = path.join(app.getPath('userData'), 'player-test-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('[dev-test] REPORT_WRITTEN', out)
  console.log('[dev-test] done')

  setTimeout(() => {
    try {
      if (!win.isDestroyed()) win.close()
    } catch {
      // ignore
    }
    app.quit()
  }, 1500)
}

module.exports = { runPlayerTests }
