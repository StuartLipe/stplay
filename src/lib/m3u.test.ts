import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseM3u } from './m3u.ts'

const withExtinf = (name: string, group = 'Geral') =>
  `#EXTM3U\n#EXTINF:-1 tvg-id="c1" tvg-logo="http://x/l.png" group-title="${group}",${name}\nhttp://p/live/u/p/1.m3u8\n`

describe('parseM3u: nome com virgula', () => {
  test('virgula dentro do nome nao trunca mais', () => {
    const ch = parseM3u(withExtinf('Top Gear, Temporada 1'))[0]
    assert.equal(ch?.name, 'Top Gear, Temporada 1')
  })

  test('virgula em varios pontos do nome', () => {
    const ch = parseM3u(withExtinf('Doctor Who, The Movie, 2023'))[0]
    assert.equal(ch?.name, 'Doctor Who, The Movie, 2023')
  })

  test('virgula dentro do group-title nao vira parte do nome', () => {
    const ch = parseM3u(withExtinf('Canal Bom', 'Filmes, Ação'))[0]
    assert.equal(ch?.group, 'Filmes, Ação')
    assert.equal(ch?.name, 'Canal Bom')
  })

  test('aspas no nome preservadas', () => {
    const ch = parseM3u(withExtinf('Fulano "O" Belga'))[0]
    assert.equal(ch?.name, 'Fulano "O" Belga')
  })

  test('atributos e id continuam correctos', () => {
    const ch = parseM3u(withExtinf('Top Gear, Temporada 1', 'Esportes'))[0]
    assert.equal(ch?.tvgId, 'c1')
    assert.equal(ch?.logo, 'http://x/l.png')
    assert.equal(ch?.group, 'Esportes')
    assert.equal(ch?.id, 'live-1')
  })
})

describe('parseM3u: desempenho e robustez', () => {
  test('50k canais sem estourar call stack nem tempo absurdo', () => {
    const block = Array.from({ length: 50_000 }, (_, i) => `#EXTINF:-1 group-title="G${i % 12}",Canal ${i}\nhttp://p/live/u/p/${i}.m3u8`).join('\n')
    const t0 = performance.now()
    const list = parseM3u(`#EXTM3U\n${block}`)
    const ms = performance.now() - t0
    assert.equal(list.length, 50_000)
    assert.ok(ms < 5000, `levou ${Math.round(ms)}ms`)
  })

  test('linhas malformadas nao quebram o parse', () => {
    const text = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="A",Sem URL',
      'http://p/live/u/p/1.m3u8',
      '#EXTINF:',
      '#EXTINF:-1,,Nome Com virgula inicial',
      'http://p/live/u/p/2.m3u8',
      'linha solta sem extinf',
      '',
    ].join('\r\n')
    const list = parseM3u(text)
    assert.equal(list.length, 2)
  })
})
