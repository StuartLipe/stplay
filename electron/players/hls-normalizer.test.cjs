const assert = require('node:assert/strict')
const { test } = require('node:test')
const { eMinhaSaida, PROXY_TOKEN } = require('./hls-normalizer.cjs')

/**
 * Guarda contra encadear saida.
 *
 * BUG REAL, encontrado por medicao e nao por leitura: o `softReloadLive`
 * recarregava a partir de `livePlayUrl`, que e a URL JA RESOLVIDA pelo
 * normalizador. O normalizador recebia a propria saida, a tratava como se fosse
 * o painel, e embrulhava de novo — uma camada por recarga.
 *
 * Medido no app:
 *   socket do demuxer morto  cacheTime=91143.696522  timePos=0
 *   start live=True url=http://127.0.0.1:58602/m/aHR0cDovLzIyMDhhaHNn...
 *
 * 91.143 segundos de buffer (25 horas) com o playhead em zero: o mpv estava
 * lendo uma playlist que apontava para outra playlist, que apontava para outra.
 */
test('reconhece a propria saida, para nao embrulhar de novo', () => {
  const b64 = Buffer.from('http://2208ahsg.top/live/u/p/1.m3u8', 'utf8').toString('base64url')
  const url = `http://127.0.0.1:58602/m/${b64}.m3u8?t=${PROXY_TOKEN}`
  assert.equal(eMinhaSaida(url), true, 'a propria saida tem de ser reconhecida')
})

test('aceita localhost e https tambem (o guard nao pode ser fragil)', () => {
  const b64 = Buffer.from('http://exemplo/live/u/p/1.m3u8', 'utf8').toString('base64url')
  assert.equal(eMinhaSaida(`http://localhost:1234/m/${b64}.m3u8?t=${PROXY_TOKEN}`), true)
  assert.equal(eMinhaSaida(`https://127.0.0.1:9/m/${b64}.m3u8?t=${PROXY_TOKEN}`), true)
})

test('NAO confunde URL do painel nem token errado com a propria saida', () => {
  const b64 = Buffer.from('http://2208ahsg.top/live/u/p/1.m3u8', 'utf8').toString('base64url')
  // URL do painel: e a entrada normal, tem de passar direto.
  assert.equal(eMinhaSaida('http://2208ahsg.top/live/u/p/1.m3u8'), false)
  // Forma certa, token de outro processo: nao e minha, e normalizar e correto.
  assert.equal(eMinhaSaida(`http://127.0.0.1:58602/m/${b64}.m3u8?t=${'a'.repeat(48)}`), false)
  // Forma de proxy local, mas outro caminho: nao e o normalizador.
  assert.equal(eMinhaSaida(`http://127.0.0.1:58602/stream?u=${b64}&t=${PROXY_TOKEN}`), false)
  // Entrada invalida.
  assert.equal(eMinhaSaida(null), false)
  assert.equal(eMinhaSaida(''), false)
  assert.equal(eMinhaSaida(123), false)
})

test('a saida reconhecida passa pelo canonicalUrl sem mudar (idempotencia)', async () => {
  const { canonicalUrl } = require('./hls-normalizer.cjs')
  const b64 = Buffer.from('http://2208ahsg.top/live/u/p/1.m3u8', 'utf8').toString('base64url')
  const url = `http://127.0.0.1:58602/m/${b64}.m3u8?t=${PROXY_TOKEN}`
  // Nao so precisa ser reconhecida: canonicalUrl tem de devolver a MESMA string.
  // Se embrulhar, a cadeia cresce a cada reload — que foi o bug.
  assert.equal(await canonicalUrl(url), url)
})
