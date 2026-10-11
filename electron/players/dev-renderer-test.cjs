const fs = require('fs')
const path = require('path')
const { app, ipcMain } = require('electron')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForVite(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // retry
    }
    await sleep(500)
  }
  return false
}

/**
 * Testa o player interno no renderer (HTMLVideo + HLS).
 * Uso: STPLAY_DEV_RENDERER_TEST=1 npm run desktop
 */
async function setupRendererTest(win) {
  const reportPath = path.join(app.getPath('userData'), 'internal-player-test-report.json')

  ipcMain.handle('dev:report-internal-test', (_event, payload) => {
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2))
    console.log('[dev-renderer-test] REPORT', reportPath)
    console.log('[dev-renderer-test]', JSON.stringify(payload))
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        // ignore
      }
      app.quit()
    }, 800)
    return { ok: true, path: reportPath }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  const ok = await waitForVite(devUrl)
  if (!ok) {
    console.error('[dev-renderer-test] Vite indisponível em', devUrl)
    app.quit()
    return
  }
  void win.loadURL(`${devUrl}?devInternalTest=1`)
}

module.exports = { setupRendererTest }
