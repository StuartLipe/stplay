/*
 * Teste do scanner de miniaturas: pré-gera em segundo plano e mede o hover.
 * Uso: npx electron tests/thumb-scan.test.cjs <url>
 */
const { app } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const URL = process.argv[2]
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  if (!URL) { console.error('uso: npx electron tests/thumb-scan.test.cjs <url>'); app.exit(2); return }

  const thumbs = require('../electron/players/thumb-service.cjs')
  const dir = path.join(app.getPath('userData'), 'thumb-cache',
    crypto.createHash('sha1').update(URL).digest('hex').slice(0, 16))
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })

  const t0 = Date.now()
  thumbs.preparar(URL)

  const contar = () => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).length } catch { return 0 }
  }
  for (let i = 1; i <= 6; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    console.log(`${String(i * 5).padStart(3)}s -> ${contar()} miniaturas prontas`)
  }

  // hover num trecho já gerado
  const t1 = Date.now()
  const a = await thumbs.miniatura(URL, 60)
  const d1 = (Date.now() - t1) / 1000
  // hover num trecho ainda não gerado
  const t2 = Date.now()
  const b = await thumbs.miniatura(URL, 1400)
  const d2 = (Date.now() - t2) / 1000

  console.log(`hover 60s: ${d1.toFixed(2)}s ${a ? 'OK' : 'FALHOU'}`)
  console.log(`hover 1400s (fora do scan): ${d2.toFixed(2)}s ${b ? 'OK' : 'FALHOU'}`)
  console.log(`total de miniaturas: ${contar()}`)

  thumbs.parar()
  app.exit(0)
})
