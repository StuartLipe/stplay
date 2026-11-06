import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractEpisodeNumber, extractSeasonNumber, getSkipTimes, parseSkipResponse } from './aniskip.ts'
import { OPED_POR_MAL } from './oped-data.ts'

test('temporada no nome: SxxExx, "Temporada N" e ausÃªncia', () => {
  assert.equal(extractSeasonNumber('Solo Leveling S02E05'), 2)
  assert.equal(extractSeasonNumber('Boku no Hero Academia S01E03'), 1)
  assert.equal(extractSeasonNumber('Boku no Hero E03'), null)
  assert.equal(extractSeasonNumber('Temporada 3 - EpisÃ³dio 1'), 3)
  assert.equal(extractSeasonNumber(''), null)
})

test('mapa embutido: toda entrada passa nas guardas do parser', () => {
  let total = 0
  for (const [malId, temporadas] of Object.entries(OPED_POR_MAL)) {
    for (const [temp, eps] of Object.entries(temporadas)) {
      for (const [ep, marca] of Object.entries(eps)) {
        const results = []
        if (marca.op) results.push({ interval: { start_time: marca.op.start, end_time: marca.op.end }, skip_type: 'op', episode_length: marca.len })
        if (marca.ed) results.push({ interval: { start_time: marca.ed.start, end_time: marca.ed.end }, skip_type: 'ed', episode_length: marca.len })
        const parsed = parseSkipResponse({ found: true, results })
        assert.ok(parsed, `${malId} T${temp} ep ${ep} nÃ£o passou nas guardas`)
        if (marca.op) assert.ok(parsed.intro, `${malId} T${temp} ep ${ep} sem OP`)
        if (marca.ed) assert.ok(parsed.outro, `${malId} T${temp} ep ${ep} sem ED`)
        total += 1
      }
    }
  }
  assert.ok(total > 0, 'mapa vazio')
})

/*
 * A resposta real da AniSkip v1. RegressÃ£o direta: o cÃ³digo anterior lia
 * `data.intro`/`data.outro`, que nÃ£o existem â€” o formato Ã© uma lista em
 * `results` com `interval.start_time`/`end_time` e `skip_type`.
 */
const REAL = {
  found: true,
  results: [
    {
      interval: { start_time: 47.365, end_time: 137.365 },
      skip_type: 'op',
      skip_id: 'c8303b7d-2e87-401b-ae30-b1a2b18943ac',
      episode_length: 1540.061,
    },
    {
      interval: { start_time: 1342.795, end_time: 1430.616 },
      skip_type: 'ed',
      skip_id: 'd7b4737b-d3b9-4009-bbbf-1fb52a02d746',
      episode_length: 1446.9973,
    },
  ],
}

test('parseSkipResponse lÃª abertura e encerramento da resposta real', () => {
  const r = parseSkipResponse(REAL)
  assert.ok(r)
  assert.deepEqual(r.intro, { start: 47.365, end: 137.365 })
  assert.deepEqual(r.outro, { start: 1342.795, end: 1430.616 })
})

/*
 * Dado ruim REAL publicado na AniSkip, observado no catÃ¡logo do servidor.
 * Sem estes filtros o player oferece "pular encerramento" aos 8:29 de um
 * episÃ³dio de 23 minutos, e a pessoa cai no meio da histÃ³ria.
 */
const NARUTO_ED_8MIN = {
  found: true,
  results: [
    { interval: { start_time: 3, end_time: 93 }, skip_type: 'op', episode_length: 1400 },
    { interval: { start_time: 509, end_time: 599 }, skip_type: 'ed', episode_length: 1400 },
  ],
}

const SOLO_ED_3MIN = {
  found: true,
  results: [
    { interval: { start_time: 62, end_time: 152 }, skip_type: 'op', episode_length: 1500 },
    { interval: { start_time: 211, end_time: 301 }, skip_type: 'ed', episode_length: 1500 },
  ],
}

test('descarta encerramento que comeÃ§a no meio do episÃ³dio', () => {
  const r = parseSkipResponse(NARUTO_ED_8MIN)
  assert.ok(r)
  assert.deepEqual(r.intro, { start: 3, end: 93 }, 'a abertura Ã© vÃ¡lida e deve sobrar')
  assert.equal(r.outro, null, 'encerramento em 8:29 Ã© lixo da base, nÃ£o uma mÃºsica final')
})

test('descarta encerramento que comeÃ§a nos 3 primeiros minutos', () => {
  const r = parseSkipResponse(SOLO_ED_3MIN)
  assert.ok(r)
  assert.deepEqual(r.intro, { start: 62, end: 152 })
  assert.equal(r.outro, null)
})

test('mantÃ©m encerramento dentro da janela final esperada', () => {
  const r = parseSkipResponse(REAL) // ed em 1342s de um episÃ³dio de 1540s
  assert.ok(r?.outro)
})

test('mantÃ©m abertura mesmo quando o episÃ³dio Ã© uma compilation longa', () => {
  // 4 minutos em um episÃ³dio de 25 minutos ainda Ã© abertura.
  const r = parseSkipResponse({
    results: [
      { interval: { start_time: 240, end_time: 330 }, skip_type: 'op', episode_length: 1500 },
      { interval: { start_time: 1400, end_time: 1490 }, skip_type: 'ed', episode_length: 1500 },
    ],
  })
  assert.deepEqual(r, { intro: { start: 240, end: 330 }, outro: { start: 1400, end: 1490 } })
})

test('descarta "abertura" que sÃ³ aparece na segunda metade do episÃ³dio', () => {
  const r = parseSkipResponse({
    results: [
      { interval: { start_time: 1050, end_time: 1140 }, skip_type: 'op', episode_length: 1500 },
      { interval: { start_time: 1400, end_time: 1490 }, skip_type: 'ed', episode_length: 1500 },
    ],
  })
  assert.deepEqual(r, { intro: null, outro: { start: 1400, end: 1490 } })
})

test('descarta intervalo que termina depois do prÃ³prio episÃ³dio', () => {
  const r = parseSkipResponse({
    results: [
      { interval: { start_time: 1400, end_time: 2000 }, skip_type: 'ed', episode_length: 1500 },
    ],
  })
  assert.equal(r, null)
})

test('sem episode_length nÃ£o filtra nada, mas continua descartando o degenerado', () => {
  const r = parseSkipResponse({
    results: [
      { interval: { start_time: 400, end_time: 500 }, skip_type: 'ed' },
      { interval: { start_time: 10, end_time: 10 }, skip_type: 'op' },
    ],
  })
  assert.deepEqual(r, { intro: null, outro: { start: 400, end: 500 } })
})

test('parseSkipResponse devolve null quando a API diz que nÃ£o achou', () => {
  assert.equal(parseSkipResponse({ found: false, results: [] }), null)
  assert.equal(parseSkipResponse({ found: true, results: [] }), null)
  assert.equal(parseSkipResponse(null), null)
  assert.equal(parseSkipResponse(undefined), null)
  assert.equal(parseSkipResponse({}), null)
})

test('parseSkipResponse aceita sÃ³ abertura, sÃ³ encerramento e tipos mistos', () => {
  const soOp = parseSkipResponse({
    results: [{ interval: { start_time: 28.783, end_time: 118.783 }, skip_type: 'op' }],
  })
  assert.deepEqual(soOp, { intro: { start: 28.783, end: 118.783 }, outro: null })

  const soEd = parseSkipResponse({
    results: [{ interval: { start_time: 1387.996, end_time: 1500 }, skip_type: 'ed' }],
  })
  assert.deepEqual(soEd, { intro: null, outro: { start: 1387.996, end: 1500 } })

  const misto = parseSkipResponse({
    results: [
      { interval: { start_time: 10, end_time: 100 }, skip_type: 'mixed-op' },
      { interval: { start_time: 1400, end_time: 1500 }, skip_type: 'mixed-ed' },
    ],
  })
  assert.deepEqual(misto, { intro: { start: 10, end: 100 }, outro: { start: 1400, end: 1500 } })
})

test('parseSkipResponse descarta intervalo degenerado ou incompleto', () => {
  assert.equal(
    parseSkipResponse({ results: [{ interval: { start_time: 10, end_time: 10 }, skip_type: 'op' }] }),
    null,
    'intervalo zerado nÃ£o serve para pular'
  )
  assert.equal(
    parseSkipResponse({ results: [{ interval: { start_time: 90, end_time: 10 }, skip_type: 'op' }] }),
    null,
    'intervalo invertido Ã© invÃ¡lido'
  )
  assert.equal(parseSkipResponse({ results: [{ interval: {}, skip_type: 'op' }] }), null)
  assert.equal(parseSkipResponse({ results: [{ skip_type: 'op' }] }), null)
  assert.equal(
    parseSkipResponse({ results: [{ interval: { start_time: 5, end_time: 95 }, skip_type: 'recap' }] }),
    null
  )
})

test('parseSkipResponse ignora tipo desconhecido sem quebrar os vÃ¡lidos', () => {
  const r = parseSkipResponse({
    results: [
      { interval: { start_time: 5, end_time: 95 }, skip_type: 'recap' },
      { interval: { start_time: 30, end_time: 120 }, skip_type: 'op' },
    ],
  })
  assert.deepEqual(r, { intro: { start: 30, end: 120 }, outro: null })
})

test('extractEpisodeNumber reconhece os formatos do servidor Xtream', () => {
  assert.equal(extractEpisodeNumber('Ataque dos Titas S01E03'), 3)
  assert.equal(extractEpisodeNumber('Ataque dos Titas S1 E03'), 3)
  assert.equal(extractEpisodeNumber('Naruto Shippuden E220'), 220)
  assert.equal(extractEpisodeNumber('EpisÃ³dio 5'), 5)
  assert.equal(extractEpisodeNumber('One Piece [L] 1045'), 1045)
  assert.equal(extractEpisodeNumber('Bleach - 366'), 366)
})

test('extractEpisodeNumber devolve null quando nÃ£o hÃ¡ nÃºmero', () => {
  assert.equal(extractEpisodeNumber('Ataque dos Titas'), null)
  assert.equal(extractEpisodeNumber(''), null)
  // stream_id nÃ£o pode virar nÃºmero de episÃ³dio
  assert.equal(extractEpisodeNumber('2273444'), null)
})
test('mapa embutido responde sem rede e marca a origem', async () => {
  const r = await getSkipTimes('31964', 1, 1)
  assert.ok(r, 'Boku no Hero E01 deveria estar no mapa')
  assert.equal(r.source, 'local')
  assert.ok(r.intro && r.intro.start > 0 && r.intro.end > r.intro.start)
})

test('temporada 2 usa os tempos da 2; temporada sem dado nao cai na 1', async () => {
  const s1 = await getSkipTimes('31964', 1, 1)
  assert.ok(s1, 'S1E1 deve existir')
  const temporada2 = OPED_POR_MAL['31964']['2']
  const ep2 = Number(Object.keys(temporada2)[0])
  const s2 = await getSkipTimes('31964', ep2, 2)
  assert.ok(s2, 'S2 deve usar o mapa da temporada 2')
  assert.notEqual(s1.intro!.start, s2.intro!.start)
  const s9 = await getSkipTimes('31964', 1, 9)
  assert.equal(s9, null, 'temporada fora do mapa nao pode herdar a 1')
})

test('episodio fora do mapa nao inventa nada', async () => {
  const r = await getSkipTimes('31964', 999)
  assert.equal(r, null)
})

test('getSkipTimes devolve exatamente os numeros do mapa (sem outra fonte)', async () => {
  let n = 0
  for (const [malId, temporadas] of Object.entries(OPED_POR_MAL)) {
    for (const [temp, eps] of Object.entries(temporadas)) {
      const season = temp === '*' ? null : Number(temp)
      for (const [ep, marco] of Object.entries(eps)) {
        const r = await getSkipTimes(malId, ep, season)
        assert.ok(r, `${malId} T${temp} ep ${ep} sem resposta`)
        assert.equal(r.source, 'local')
        if (marco.op) {
          assert.equal(r.intro!.start, marco.op.start, `${malId} ep ${ep} OP inicio`)
          assert.equal(r.intro!.end, marco.op.end, `${malId} ep ${ep} OP fim`)
        }
        if (marco.ed) {
          assert.equal(r.outro!.start, marco.ed.start, `${malId} ep ${ep} ED inicio`)
          assert.equal(r.outro!.end, marco.ed.end, `${malId} ep ${ep} ED fim`)
        }
        n += 1
      }
    }
  }
  assert.ok(n > 100, `esperava o mapa inteiro, veio ${n}`)
})
