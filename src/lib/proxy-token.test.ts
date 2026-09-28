// Regressao para o token de sessao do proxy local (electron/stream-proxy.cjs).
//
// O proxy escuta em 127.0.0.1 com porta efemera, o que bloqueia acesso externo,
// mas qualquer pagina aberta no navegador do usuario ainda podia achar a porta
// (404 vs 400/200 e trivial de distinguir) e usar o app como proxy CORS-bypass
// contra a LAN e o loopback — lendo a resposta cross-origin, porque a resposta
// mandava `access-control-allow-origin: *`.
//
// A base que o main entrega ao renderer passou a carregar `?t=<token>`, entao
// estes testes garatem que o token sobrevive a transformacao /proxy -> /stream.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { playSrc } from './proxy.ts'

const TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

function withProxyBase(base: string | undefined) {
  ;(globalThis as { window?: unknown }).window = {
    sturplay: base === undefined ? {} : { proxyBase: base },
  }
}

function restoreWindow() {
  delete (globalThis as { window?: unknown }).window
}

describe('proxy: token de sessao sobrevive a troca de endpoint', () => {
  test('/proxy mantem o token e adiciona url', () => {
    withProxyBase(`http://127.0.0.1:5000/proxy?t=${TOKEN}`)
    const out = playSrc('http://panel/live/u/p/1.m3u8')
    restoreWindow()
    const u = new URL(out)
    assert.equal(u.pathname, '/proxy')
    assert.equal(u.searchParams.get('t'), TOKEN, 'token preservado')
    assert.equal(u.searchParams.get('url'), 'http://panel/live/u/p/1.m3u8')
  })

  test('/stream troca o path mas mantem o token', () => {
    withProxyBase(`http://127.0.0.1:5000/proxy?t=${TOKEN}`)
    const out = playSrc('http://cdn/video.mp4')
    restoreWindow()
    const u = new URL(out)
    assert.equal(u.pathname, '/stream', 'path trocado para /stream')
    assert.equal(u.searchParams.get('t'), TOKEN, 'token NAO pode ser perdido na troca de path')
    assert.equal(u.searchParams.get('u'), 'http://cdn/video.mp4')
  })

  test('nao gera query dupla do tipo ?t=...?url=', () => {
    withProxyBase(`http://127.0.0.1:5000/proxy?t=${TOKEN}`)
    const out = playSrc('http://cdn/video.mp4')
    restoreWindow()
    assert.ok(!out.includes('??'), 'sem interrogacoes consecutivas')
    assert.ok(!out.includes(`${TOKEN}?`), 'token nao pode vir seguido de ?')
    const u = new URL(out)
    assert.equal(u.searchParams.get('t'), TOKEN)
    assert.equal(u.searchParams.get('u'), 'http://cdn/video.mp4')
  })

  test('url remota com query e ampersand sobrevive inteira', () => {
    withProxyBase(`http://127.0.0.1:5000/proxy?t=${TOKEN}`)
    const target = 'http://panel/player_api.php?username=u&password=p&action=get_live_streams'
    const out = playSrc(target)
    restoreWindow()
    const u = new URL(out)
    assert.equal(u.searchParams.get('url'), target, 'alvo com & e ? preservado byte a byte')
    assert.equal(u.searchParams.get('t'), TOKEN)
  })

  test('base sem token (dev/vite) continua funcionando', () => {
    withProxyBase('/api/proxy')
    const out = playSrc('http://panel/live/u/p/1.m3u8')
    restoreWindow()
    assert.ok(out.startsWith('/api/proxy?'), 'fallback de desenvolvimento intacto')
  })

  test('sem base nenhuma cai no dev server', () => {
    withProxyBase(undefined)
    const out = playSrc('http://panel/live/u/p/1.m3u8')
    restoreWindow()
    assert.ok(out.startsWith('/api/proxy?'))
  })
})
