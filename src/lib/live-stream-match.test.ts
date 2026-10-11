/**
 * O painel rotaciona o `stream_id` do canal. Sem re-resolver, abrir um canal que
 * morreu ha dez minutos insiste no ID morto — e o app so pode falhar honesto,
 * o que e melhor que girar para sempre, mas ainda trata como morto um canal que
 * EXISTE.
 *
 * Estes testes seguram o casamento (tvg-id primeiro, nome normalizado depois) e,
 * mais importante, a trava contra o laco: resolver nao pode devolver o MESMO
 * id, senao o chamador reabre a mesma URL morta e a checagem nunca converge.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { matchLiveStream, normalizeChannelName } from './live-stream-match.ts'

test('normalizacao tira acento, qualidade e pontuacao', () => {
  assert.equal(normalizeChannelName('Baby First SD'), 'babyfirst')
  assert.equal(normalizeChannelName('Baby First HD'), 'babyfirst')
  assert.equal(normalizeChannelName('BABY FIRST FHD'), 'babyfirst')
  assert.equal(normalizeChannelName('Café Byte'), 'cafebyte')
  assert.equal(normalizeChannelName('Canal  24  -  News'), 'canal24news')
  assert.equal(normalizeChannelName('Esporte 4K'), 'esporte')
})

test('tvg-id manda quando existe', () => {
  const streams = [
    { stream_id: 111, name: 'Canal Um', epg_channel_id: 'canal.um.pt' },
    { stream_id: 222, name: 'Nome Completamente Diferente', epg_channel_id: 'babyfirst.pt' },
  ]
  const m = matchLiveStream(streams, { name: 'Baby First SD', tvgId: 'babyfirst.pt', streamId: '999' })
  assert.equal(m?.stream_id, 222, 'o tvg-id gana do nome propositalmente diferente')
})

test('sem tvg-id, casa pelo nome normalizado', () => {
  const streams = [
    { stream_id: 111, name: 'Outro Canal', epg_channel_id: '' },
    { stream_id: 222, name: 'Baby First SD', epg_channel_id: '' },
  ]
  const m = matchLiveStream(streams, { name: 'Baby First HD', streamId: '999' })
  assert.equal(m?.stream_id, 222)
})

test('NUNCA casa com o proprio stream_id', () => {
  // Se a unica entrada com aquele nome e a que ja estamos usando, o resultado
  // tem de ser null. Devolver o mesmo id faria o chamador reabrir a URL morta.
  const streams = [{ stream_id: 709056, name: 'Baby First SD', epg_channel_id: '' }]
  assert.equal(matchLiveStream(streams, { name: 'Baby First SD', streamId: '709056' }), null)
})

test('nome ambiguo com varias entradas pega a primeira que nao seja a atual', () => {
  const streams = [
    { stream_id: 709056, name: 'Baby First SD', epg_channel_id: '' },
    { stream_id: 709057, name: 'Baby First SD', epg_channel_id: '' },
  ]
  const m = matchLiveStream(streams, { name: 'Baby First SD', streamId: '709056' })
  assert.equal(m?.stream_id, 709057)
})

test('tvg-id igual mas stream_id igual tambem: nao re-resolve', () => {
  const streams = [{ stream_id: 709056, name: 'Qualquer', epg_channel_id: 'babyfirst.pt' }]
  assert.equal(matchLiveStream(streams, { name: 'Baby', tvgId: 'babyfirst.pt', streamId: '709056' }), null)
})

test('canal inexistente devolve null em vez de chutar', () => {
  const streams = [{ stream_id: 1, name: 'Outro', epg_channel_id: '' }]
  assert.equal(matchLiveStream(streams, { name: 'Baby First SD', streamId: '5' }), null)
})

test('sem streamId, tvg-id nem nome, nao tenta', () => {
  const streams = [{ stream_id: 1, name: 'X', epg_channel_id: '' }]
  assert.equal(matchLiveStream(streams, { name: '', streamId: '' }), null)
})

test('lista vazia devolve null', () => {
  assert.equal(matchLiveStream([], { name: 'Baby First SD', streamId: '5' }), null)
})
