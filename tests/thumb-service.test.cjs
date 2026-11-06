/*
 * Teste do serviço de miniaturas (mpv quente + cache).
 *
 * Uso: npx electron tests/thumb-service.test.cjs <url>
 *
 * Verifica: primeira captura, segunda em outro tempo e a mesma de novo
 * (cache). Sai 0 se as três voltarem como JPEG em data URL.
 */
const { app } = require('electron')

const URL = process.argv[2]

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  if (!URL) {
    console.error('uso: npx electron tests/thumb-service.test.cjs <url>')
    app.exit(2)
    return
  }

  const thumbs = require('../electron/players/thumb-service.cjs')

  const medir = async (rotulo, tempo) => {
    const t0 = Date.now()
    const r = await thumbs.miniatura(URL, tempo)
    const dt = (Date.now() - t0) / 1000
    const ok = typeof r === 'string' && r.startsWith('data:image/jpeg;base64,')
    console.log(`${rotulo.padEnd(18)} ${tempo}s -> ${dt.toFixed(2)}s ${ok ? `OK (${Math.round(r.length / 1024)} KB)` : 'FALHOU'}`)
    return ok
  }

  const a = await medir('primeira', 300)
  const b = await medir('outro tempo', 1200)
  const c = await medir('cache (mesmo)', 300)

  thumbs.parar()
  app.exit(a && b && c ? 0 : 1)
})
