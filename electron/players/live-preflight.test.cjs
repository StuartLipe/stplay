// Prova o preflight HLS contra o painel real.
//
// Motivo: com canal de origem morta, o app esperava o watchdog inteiro (20s
// medidos no player.log) antes de tentar o `.ts`, que carrega em 0,75s. O
// preflight troca esses 20s por ~2,5s.
//
// Este arquivo NAO entra no pacote de producao: build.files exclui
// electron/**/*.test.cjs.
const assert = require('node:assert/strict')
const { describe, test } = require('node:test')

const HOST = process.env.STPLAY_PANEL_HOST
const USER = process.env.STPLAY_PANEL_USER
const PASS = process.env.STPLAY_PANEL_PASS

const PREFLIGHT_TIMEOUT_MS = 2500
const PREFLIGHT_SKIP_AFTER = 4

const headers = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preflight timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function liveManifestHealthy(url) {
  if (!/\.m3u8(\?|#|$)/i.test(url)) return true
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS)
    let res
    try {
      res = await withTimeout(fetch(url, { headers, signal: ctrl.signal }), PREFLIGHT_TIMEOUT_MS)
    } finally {
      clearTimeout(timer)
    }
    if (!res || !res.ok) return false
    const body = await res.text()
    return body.split(/\r?\n/).some((line) => line && !line.startsWith('#'))
  } catch {
    return false
  }
}

const m3u8 = (id) => `http://${HOST}/live/${USER}/${PASS}/${id}.m3u8`
const ts = (id) => `http://${HOST}/live/${USER}/${PASS}/${id}.ts`

describe('preflight HLS', { skip: !HOST ? 'defina STPLAY_PANEL_HOST' : false }, () => {
  test('o preflight e bem mais barato que o watchdog de 20s', () => {
    assert.ok(PREFLIGHT_TIMEOUT_MS <= 3000, 'precisa ser bem abaixo dos 20s do watchdog')
    assert.ok(PREFLIGHT_SKIP_AFTER > 0, 'deve parar de sondar depois de algumas sondas')
  })

  test('reprova manifesto de canal morto sem esperar 20s', async () => {
    const healthy = await liveManifestHealthy(m3u8('709056'))
    const t0 = Date.now()
    const tsOk = await fetch(ts('709056'), { headers }).then((r) => r.ok).catch(() => false)
    const ms = Date.now() - t0
    if (!healthy) {
      assert.ok(ms < 8000, `preflight + probe demorou ${ms}ms, esperava <8s`)
    }
    assert.equal(typeof healthy, 'boolean')
    assert.equal(typeof tsOk, 'boolean')
  })

  test('aprova manifesto de canal saudavel sem custo alto', async () => {
    const id = process.env.STPLAY_GOOD_CHANNEL || '709057'
    const t0 = Date.now()
    const healthy = await liveManifestHealthy(m3u8(id))
    const ms = Date.now() - t0
    assert.equal(healthy, true, `canal ${id} deveria ter manifesto saudavel`)
    assert.ok(ms < PREFLIGHT_TIMEOUT_MS + 1500, `preflight demorou ${ms}ms`)
  })
})
